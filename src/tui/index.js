import React from 'react';
import { render } from 'ink';
import { App } from './app.js';

const ENTER_ALT_SCREEN = '\u001B[?1049h\u001B[H';
const LEAVE_ALT_SCREEN = '\u001B[?1049l';

export function startTui(options) {
  process.stdout.write(ENTER_ALT_SCREEN);

  const instance = render(React.createElement(App, options), {
    exitOnCtrlC: false,
    patchConsole: false
  });

  let restored = false;
  function restore() {
    if (restored) return;
    restored = true;
    process.stdout.write(LEAVE_ALT_SCREEN);
  }

  return {
    ...instance,
    async waitUntilExit() {
      try {
        await instance.waitUntilExit();
      } finally {
        restore();
      }
    },
    unmount() {
      instance.unmount();
      restore();
    }
  };
}
