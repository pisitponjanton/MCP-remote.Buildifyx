import { useEffect, useMemo, useState } from 'react';

function terminalSize() {
  return {
    columns: Math.max(1, process.stdout.columns ?? 100),
    rows: Math.max(1, process.stdout.rows ?? 32)
  };
}

export function calculateTuiLayout({ columns, rows, hasUpdate = false }) {
  const safeColumns = Math.max(1, Number(columns) || 1);
  const safeRows = Math.max(1, Number(rows) || 1);
  const narrow = safeColumns < 84;
  const compact = safeColumns < 110 || safeRows < 30;
  const canvasRows = Math.max(1, safeRows - 1);

  // Header = title/status + version + instance + workspace + access + margin,
  // plus one extra line when an update notice is visible. Controls reserve the
  // worst-case two-line content plus borders. The final status uses one line.
  const headerRows = hasUpdate ? 7 : 6;
  const controlsRows = 4;
  const messageRows = 1;
  const reservedRows = headerRows + controlsRows + messageRows;
  const availableRows = Math.max(0, canvasRows - reservedRows);
  const tooSmall = safeColumns < 52 || availableRows < (narrow ? 10 : 5);
  const panelHeight = tooSmall
    ? 0
    : narrow
      ? Math.max(3, Math.floor(availableRows / 2))
      : Math.max(3, availableRows);
  const activityWindow = panelHeight > 0
    ? Math.max(1, Math.floor((panelHeight - 3) / (compact ? 2 : 3)))
    : 0;

  return {
    columns: safeColumns,
    rows: safeRows,
    canvasRows,
    narrow,
    compact,
    tooSmall,
    headerRows,
    controlsRows,
    messageRows,
    reservedRows,
    availableRows,
    panelHeight,
    activityWindow,
    activityWidth: narrow ? '100%' : compact ? '55%' : '60%',
    statusWidth: narrow ? '100%' : compact ? '45%' : '40%'
  };
}

export function useTerminalSize() {
  const [size, setSize] = useState(terminalSize);

  useEffect(() => {
    const handleResize = () => setSize(terminalSize());
    process.stdout.on('resize', handleResize);
    return () => process.stdout.off('resize', handleResize);
  }, []);

  return size;
}

export function useTuiLayout({ hasUpdate = false } = {}) {
  const { columns, rows } = useTerminalSize();
  return useMemo(() => calculateTuiLayout({ columns, rows, hasUpdate }), [columns, rows, hasUpdate]);
}
