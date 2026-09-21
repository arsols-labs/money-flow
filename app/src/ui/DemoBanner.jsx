import React from 'react';
import { useTranslation } from 'react-i18next';

export default function DemoBanner() {
  const { t } = useTranslation();
  return (
    <div className="demo-banner" role="status">
      {t('auth.demoBanner')}
    </div>
  );
}
