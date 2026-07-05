import readline from 'node:readline';

export interface PromptOption {
  /** Short key recorded as the answer (e.g. 'A', 'B', 'REDESIGN', 'SKIP'). */
  key: string;
  label: string;
}

/**
 * Arrow-key selection when running in a real terminal; plain typed input
 * otherwise (CI logs, piped stdio). No dependencies.
 */
export async function selectOption(title: string, options: PromptOption[]): Promise<string> {
  if (process.stdin.isTTY && process.stdout.isTTY) {
    return selectWithArrows(title, options);
  }
  return selectWithReadline(title, options);
}

function selectWithReadline(title: string, options: PromptOption[]): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(title);
  for (const o of options) console.log(`  [${o.key}] ${o.label}`);
  return new Promise((resolve) => {
    const ask = () => {
      rl.question(`Choose (${options.map((o) => o.key).join('/')}): `, (raw) => {
        const answer = raw.trim().toUpperCase();
        const hit = options.find((o) => o.key.toUpperCase() === answer);
        if (hit) {
          rl.close();
          resolve(hit.key);
        } else {
          ask();
        }
      });
    };
    ask();
  });
}

function selectWithArrows(title: string, options: PromptOption[]): Promise<string> {
  return new Promise((resolve) => {
    let index = 0;
    const render = (first = false) => {
      if (!first) {
        readline.moveCursor(process.stdout, 0, -options.length);
      }
      for (let i = 0; i < options.length; i++) {
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        const marker = i === index ? '›' : ' ';
        process.stdout.write(`${marker} [${options[i]!.key}] ${options[i]!.label}\n`);
      }
    };
    console.log(`${title}  (↑/↓ + Enter, or press the option key)`);
    render(true);

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onKeypress = (str: string | undefined, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        process.exit(130);
      }
      if (key.name === 'up') {
        index = (index - 1 + options.length) % options.length;
        render();
      } else if (key.name === 'down') {
        index = (index + 1) % options.length;
        render();
      } else if (key.name === 'return') {
        cleanup();
        resolve(options[index]!.key);
      } else if (str) {
        const hit = options.findIndex((o) => o.key.toUpperCase() === str.toUpperCase());
        if (hit >= 0) {
          index = hit;
          render();
          cleanup();
          resolve(options[index]!.key);
        }
      }
    };
    const cleanup = () => {
      process.stdin.removeListener('keypress', onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    process.stdin.on('keypress', onKeypress);
  });
}
