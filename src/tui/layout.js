import { useEffect, useMemo, useState } from 'react';

function terminalSize() {
  return {
    columns: Math.max(40, process.stdout.columns ?? 100),
    rows: Math.max(16, process.stdout.rows ?? 32)
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

export function useTuiLayout() {
  const { columns, rows } = useTerminalSize();

  return useMemo(() => {
    const narrow = columns < 84;
    const compact = columns < 110 || rows < 30;
    const reservedRows = 8;
    const availableRows = Math.max(8, rows - reservedRows);
    const panelHeight = narrow
      ? Math.max(7, Math.floor(availableRows / 2))
      : Math.max(10, availableRows);
    const activityWindow = Math.max(2, Math.floor((panelHeight - 2) / (compact ? 2 : 3)));

    return {
      columns,
      rows,
      narrow,
      compact,
      panelHeight,
      activityWindow,
      activityWidth: narrow ? '100%' : compact ? '55%' : '60%',
      statusWidth: narrow ? '100%' : compact ? '45%' : '40%'
    };
  }, [columns, rows]);
}
