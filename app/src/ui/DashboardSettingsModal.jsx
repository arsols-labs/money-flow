import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  SlidersHorizontal, X, ArrowUp, ArrowDown, GripVertical, RotateCcw,
  Eye, EyeOff, Check,
} from 'lucide-react';
import {
  DASHBOARD_BLOCK_DEFS,
  moveBlock,
  reorderBlock,
  toggleBlockVisibility,
  cloneConfig,
} from './dashboardLayout';
import { blockDescription, blockTitle } from './i18nLabels';

/**
 * Изменяет колонку размещения блока с валидацией по allowedColumns переданного blockDefs.
 * @param {any[]} config
 * @param {string} id
 * @param {string} column
 * @param {Record<string, any>} [blockDefs]
 * @returns {any[]}
 */
export function applyBlockColumnChange(config, id, column, blockDefs = DASHBOARD_BLOCK_DEFS) {
  const def = blockDefs?.[id];
  if (def?.allowedColumns && !def.allowedColumns.includes(column)) {
    return config;
  }
  return config.map((b) => (b.id === id ? { ...b, column } : { ...b }));
}

/**
 * @param {{
 *   open: boolean,
 *   onClose: () => void,
 *   config: any[],
 *   onChange: (next: any[]) => void,
 *   onReset: () => void,
 *   title?: string,
 *   description?: string,
 *   blockDefs?: Record<string, any>,
 * }} props
 */
export default function DashboardSettingsModal({
  open,
  onClose,
  config,
  onChange,
  onReset,
  title: titleProp,
  description: descriptionProp,
  blockDefs = DASHBOARD_BLOCK_DEFS,
}) {
  const { t } = useTranslation();
  const title = titleProp ?? t('dashboard.settings.title');
  const description = descriptionProp ?? t('dashboard.settings.description');
  const modalRef = useRef(null);
  const [draggedIndex, setDraggedIndex] = useState(null);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const handleMove = (index, direction) => {
    const next = moveBlock(config, index, direction);
    onChange(next);
  };

  const handleToggle = (id) => {
    const next = toggleBlockVisibility(config, id);
    onChange(next);
  };

  const handleColumnChange = (id, column) => {
    const next = applyBlockColumnChange(config, id, column, blockDefs);
    onChange(next);
  };

  const handleDragStart = (e, index) => {
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = (e, targetIndex) => {
    e.preventDefault();
    const sourceIndex = draggedIndex !== null
      ? draggedIndex
      : Number(e.dataTransfer.getData('text/plain'));

    setDraggedIndex(null);
    if (!Number.isNaN(sourceIndex) && sourceIndex !== targetIndex) {
      const next = reorderBlock(config, sourceIndex, targetIndex);
      onChange(next);
    }
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
  };

  return (
    <div
      className="dashboard-modal-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="dashboard-modal"
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dashboard-modal-title"
      >
        <div className="dashboard-modal-header">
          <div className="dashboard-modal-title" id="dashboard-modal-title">
            <SlidersHorizontal size={18} aria-hidden="true" />
            <span>{title}</span>
          </div>
          <button
            type="button"
            className="dashboard-modal-close"
            onClick={onClose}
            aria-label={t('dashboard.settings.closeAria', { title })}
          >
            <X size={16} />
          </button>
        </div>

        <p className="dashboard-modal-desc">
          {description}
        </p>

        <div className="dashboard-modal-body">
          <div className="dashboard-blocks-list" role="list" aria-label={t('dashboard.settings.listAria', { title })}>
            {config.map((block, index) => {
              const def = blockDefs[block.id] || {
                id: block.id,
                title: block.id,
                description: '',
                allowedColumns: ['left', 'right', 'full'],
              };
              const defTitle = blockTitle(def, t);
              const defDescription = blockDescription(def, t);
              const isFirst = index === 0;
              const isLast = index === config.length - 1;
              const isHidden = !block.visible;
              const isDragging = draggedIndex === index;

              return (
                <div
                  key={block.id}
                  className={`dashboard-block-row ${isHidden ? 'dashboard-block-row--hidden' : ''} ${isDragging ? 'dashboard-block-row--dragging' : ''}`}
                  draggable
                  onDragStart={(e) => handleDragStart(e, index)}
                  onDragOver={handleDragOver}
                  onDrop={(e) => handleDrop(e, index)}
                  onDragEnd={handleDragEnd}
                  role="listitem"
                >
                  <div
                    className="dashboard-block-drag"
                    title={t('dashboard.settings.dragTitle')}
                    aria-hidden="true"
                  >
                    <GripVertical size={16} />
                  </div>

                  <div className="dashboard-block-info">
                    <div className="dashboard-block-title-row">
                      <span className="dashboard-block-title">{defTitle}</span>
                      {isHidden && (
                        <span className="dashboard-block-badge">{t('dashboard.settings.hiddenBadge')}</span>
                      )}
                    </div>
                    {defDescription && (
                      <div className="dashboard-block-desc">{defDescription}</div>
                    )}

                    {/* Выбор колонки для широкого экрана */}
                    {def.allowedColumns && def.allowedColumns.length > 1 && (
                      <div className="dashboard-block-column-picker">
                        <span className="dashboard-column-label">{t('dashboard.settings.columnLabel')}</span>
                        <div className="dashboard-column-chips" role="group" aria-label={t('dashboard.settings.columnForBlock', { title: defTitle })}>
                          {def.allowedColumns.includes('auto') && (
                            <button
                              type="button"
                              className={`dashboard-col-chip ${(!block.column || block.column === 'auto') ? 'dashboard-col-chip--active' : ''}`}
                              onClick={() => handleColumnChange(block.id, 'auto')}
                              title={t('dashboard.settings.column.autoTitle')}
                            >
                              {t('dashboard.settings.column.auto')}
                            </button>
                          )}
                          {def.allowedColumns.includes('left') && (
                            <button
                              type="button"
                              className={`dashboard-col-chip ${block.column === 'left' ? 'dashboard-col-chip--active' : ''}`}
                              onClick={() => handleColumnChange(block.id, 'left')}
                              title={t('dashboard.settings.column.leftTitle')}
                            >
                              {t('dashboard.settings.column.left')}
                            </button>
                          )}
                          {def.allowedColumns.includes('right') && (
                            <button
                              type="button"
                              className={`dashboard-col-chip ${block.column === 'right' ? 'dashboard-col-chip--active' : ''}`}
                              onClick={() => handleColumnChange(block.id, 'right')}
                              title={t('dashboard.settings.column.rightTitle')}
                            >
                              {t('dashboard.settings.column.right')}
                            </button>
                          )}
                          {def.allowedColumns.includes('full') && (
                            <button
                              type="button"
                              className={`dashboard-col-chip ${block.column === 'full' ? 'dashboard-col-chip--active' : ''}`}
                              onClick={() => handleColumnChange(block.id, 'full')}
                              title={t('dashboard.settings.column.fullTitle')}
                            >
                              {t('dashboard.settings.column.full')}
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="dashboard-block-actions">
                    <div className="dashboard-order-btns">
                      <button
                        type="button"
                        className="dashboard-icon-btn"
                        onClick={() => handleMove(index, 'up')}
                        disabled={isFirst}
                        aria-label={t('dashboard.settings.moveUpAria', { title: defTitle })}
                        title={t('dashboard.settings.moveUp')}
                      >
                        <ArrowUp size={15} />
                      </button>
                      <button
                        type="button"
                        className="dashboard-icon-btn"
                        onClick={() => handleMove(index, 'down')}
                        disabled={isLast}
                        aria-label={t('dashboard.settings.moveDownAria', { title: defTitle })}
                        title={t('dashboard.settings.moveDown')}
                      >
                        <ArrowDown size={15} />
                      </button>
                    </div>

                    <button
                      type="button"
                      className={`dashboard-toggle-btn ${block.visible ? 'dashboard-toggle-btn--visible' : 'dashboard-toggle-btn--hidden'}`}
                      onClick={() => handleToggle(block.id)}
                      aria-label={block.visible ? t('dashboard.settings.hideAria', { title: defTitle }) : t('dashboard.settings.showAria', { title: defTitle })}
                      title={block.visible ? t('dashboard.settings.hideBlock') : t('dashboard.settings.showBlock')}
                    >
                      {block.visible ? <Eye size={16} /> : <EyeOff size={16} />}
                      <span className="dashboard-toggle-text">
                        {block.visible ? t('dashboard.settings.visible') : t('dashboard.settings.hidden')}
                      </span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="dashboard-modal-footer">
          <button
            type="button"
            className="btn-secondary dashboard-reset-btn"
            onClick={onReset}
            title={t('dashboard.settings.resetTitle')}
          >
            <RotateCcw size={14} />
            <span>{t('common.reset')}</span>
          </button>
          <button
            type="button"
            className="btn-primary dashboard-done-btn"
            onClick={onClose}
          >
            <Check size={14} />
            <span>{t('common.done')}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
