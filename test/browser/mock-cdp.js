// CDP fixture: a new loader ID is emitted ONLY by commitMainDocument.
// Same-document history.pushState/replaceState must not call this event.
export function attachMockCdp(context) {
  const sessions = new WeakMap();
  let next = 0;
  context.newCDPSession = async page => {
    const id = 'main-frame-' + ++next;
    const handlers = new Map();
    const session = {
      on(event, handler) { handlers.set(event, handler); },
      async send(command) {
        if (command === 'Page.getFrameTree')
          return { frameTree: { frame: { id, loaderId: 'initial-loader-' + id } } };
        return {};
      },
      async detach() {}
    };
    sessions.set(page, { id, handlers });
    return session;
  };
  return {
    commitMainDocument(page, url) {
      const record = sessions.get(page);
      if (!record) throw new Error('No main-frame CDP fixture for this page.');
      record.handlers.get('Page.frameNavigated')?.({
        frame: { id: record.id, loaderId: 'committed-loader-' + ++next, url }
      });
    },
    sameDocumentNavigation(page, url) {
      const record = sessions.get(page);
      record?.handlers.get('Page.navigatedWithinDocument')?.({
        frameId: record.id, url
      });
    }
  };
}
