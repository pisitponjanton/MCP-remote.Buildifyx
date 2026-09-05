import { getLocalGatewayStatus } from '../local/gateway-control.js';

export function createLocalGatewayAgent({ environment, eventBus, instanceId, pollMs = 3000 }) {
  const listeners = new Set();
  let timer = null;
  let stopped = false;
  let state = { status: 'disconnected', endpoint: null, instanceId, lastError: null };

  function setState(patch) {
    state = { ...state, ...patch };
    eventBus?.emit('local.connection', state);
    for (const listener of listeners) listener({ ...state });
  }

  async function refresh() {
    if (stopped) return;
    try {
      const gateway = await getLocalGatewayStatus(environment);
      if (gateway.running) {
        setState({
          status: 'connected',
          endpoint: `http://127.0.0.1:${gateway.state.port}/mcp`,
          connectedAt: state.connectedAt ?? new Date().toISOString(),
          lastError: null
        });
      } else {
        setState({ status: 'disconnected', endpoint: null, connectedAt: null, lastError: 'Local gateway is not running.' });
      }
    } catch (error) {
      setState({ status: 'disconnected', endpoint: null, connectedAt: null, lastError: error?.message ?? String(error) });
    }
  }

  function connect() {
    if (timer || stopped) return;
    void refresh();
    timer = setInterval(() => { void refresh(); }, pollMs);
    timer.unref?.();
  }

  async function stop() {
    stopped = true;
    clearInterval(timer);
    timer = null;
    setState({ status: 'stopped' });
  }

  return {
    connect,
    stop,
    refresh,
    getState: () => ({ ...state }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  };
}
