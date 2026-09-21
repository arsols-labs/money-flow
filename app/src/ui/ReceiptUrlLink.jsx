import React from 'react';
import { useTranslation } from 'react-i18next';
import { parseHttpUrl } from '../shared/http-url';

/**
 * Compact i18n label for a fiscal/verification URL. Never prints the href.
 * Safe: only http(s) become links; click does not toggle the parent row.
 */
export function ReceiptUrlLink({ url, className = 'receipt-url-link' }) {
  const { t } = useTranslation();
  const href = typeof url === 'string' ? parseHttpUrl(url) : null;
  if (!href) return null;

  const stopRowToggle = (e) => {
    e.stopPropagation();
  };

  return (
    <a
      className={className}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={stopRowToggle}
      onMouseDown={stopRowToggle}
    >
      {t('common.link')}
    </a>
  );
}

export function compactComment(text, max = 80) {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();
  if (!trimmed) return '';
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}
