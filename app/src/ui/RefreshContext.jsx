// Глобальное обновление данных без перезагрузки страницы (issue #381).
//
// Зачем: кнопка «Обновить» в шапке должна реально перечитать данные всех
// экранов (Пульс, Данные, Доступ), а не делать window.location.reload() —
// рефреш страницы средствами браузера роняет все локальные состояния
// (развёрнутые блоки «Данных», фильтры, выбранный период Пульса) и виден
// пользователю как «моргание».
//
// Как работает: провайдер держит счётчик `nonce`. Shell поднимает его по
// клику иконки; каждый экран/секция подписывается на него через
// useRefreshNonce() и перезапускает свой load() в эффекте от nonce. Сброс
// кеша «Данных» (useLoadWhenExpanded грузит блок один раз) тоже идёт через
// nonce — эффект сбрасывает startedRef перед повторным load().
//
// StrictMode дважды монтирует эффекты в dev: nonce там меняться не должен от
// самого монтажа (изменяется только по клику), поэтому зависимость — только
// [nonce]. Двойной вызов load() в dev безвреден (idempotent fetch).
import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';

const RefreshContext = createContext(null);

export function RefreshProvider({ children }) {
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const value = useMemo(() => ({ nonce, refresh }), [nonce, refresh]);
  return <RefreshContext.Provider value={value}>{children}</RefreshContext.Provider>;
}

// Подписка на счётчик обновлений. Возвращает текущее значение nonce; эффект,
// зависящий от него, перезапустит загрузку данных при каждом клике «Обновить».
export function useRefreshNonce() {
  const ctx = useContext(RefreshContext);
  if (!ctx) throw new Error('useRefreshNonce must be used within RefreshProvider');
  return ctx.nonce;
}

// Функция, которую Shell вызывает по клику иконки «Обновить».
export function useRefresh() {
  const ctx = useContext(RefreshContext);
  if (!ctx) throw new Error('useRefresh must be used within RefreshProvider');
  return ctx.refresh;
}
