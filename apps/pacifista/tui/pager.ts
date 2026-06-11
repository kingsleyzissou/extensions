import { Prompt, isCancel, getRows, getColumns } from '@clack/core';
import { styleText } from 'node:util';

/**
 * A scrollable pager component built on @clack/core.
 *
 * Displays text in a viewport that fits the terminal, with
 * j/k/↑/↓ scrolling and q/enter to dismiss. Renders with
 * clack's bar chrome on the left edge.
 */
export async function pager(text: string, title?: string): Promise<void> {
  const lines = text.split('\n');

  let scrollOffset = 0;

  // Shared viewport height — recomputed each render, read by event handlers.
  // Centralises the formula so render() and cursor/key handlers can't drift.
  let viewportHeight = 1;

  function recomputeViewport(): void {
    const totalRows = getRows(process.stdout);
    const headerLines = title ? 2 : 0;
    const footerLines = 2;
    viewportHeight = Math.max(1, totalRows - headerLines - footerLines);
  }

  const p = new Prompt<void>(
    {
      render() {
        recomputeViewport();
        const totalCols = getColumns(process.stdout);

        // Clamp scroll offset
        const maxOffset = Math.max(0, lines.length - viewportHeight);
        scrollOffset = Math.min(scrollOffset, maxOffset);

        const visibleLines = lines.slice(scrollOffset, scrollOffset + viewportHeight);

        // Build the frame
        const parts: string[] = [];

        const bar = styleText('gray', '│');
        const tee = styleText('gray', '├');

        if (title) {
          parts.push(bar);
          parts.push(`${bar}  ${styleText('bold', title)}`);
        }

        for (const line of visibleLines) {
          // Truncate long lines to terminal width (account for bar prefix)
          const maxLen = totalCols - 4;
          const truncated = line.length > maxLen ? line.slice(0, maxLen) : line;
          parts.push(`${bar}  ${truncated}`);
        }

        // Pad if content is shorter than viewport
        for (let i = visibleLines.length; i < viewportHeight; i++) {
          parts.push(bar);
        }

        // Footer with scroll position
        const position =
          lines.length <= viewportHeight
            ? ''
            : ` ${styleText('dim', `${scrollOffset + 1}-${Math.min(scrollOffset + viewportHeight, lines.length)} of ${lines.length}`)}`;
        const hint = styleText('dim', '↑/↓ scroll · q quit');
        parts.push(`${tee}  ${hint}${position}`);
        parts.push(bar);

        return parts.join('\n');
      },
    },
    false,
  );

  p.on('cursor', action => {
    const maxOffset = Math.max(0, lines.length - viewportHeight);

    switch (action) {
      case 'up':
        scrollOffset = Math.max(0, scrollOffset - 1);
        break;
      case 'down':
        scrollOffset = Math.min(maxOffset, scrollOffset + 1);
        break;
    }
  });

  // Handle page-up/page-down and q to quit
  p.on('key', (char, key) => {
    const maxOffset = Math.max(0, lines.length - viewportHeight);
    const pageSize = Math.max(1, viewportHeight - 2);

    if (char === 'q' || char === 'Q') {
      p.state = 'submit';
      return;
    }

    // Space for page down
    if (key.name === 'space') {
      scrollOffset = Math.min(maxOffset, scrollOffset + pageSize);
      return;
    }

    // Page up/down
    if (key.name === 'pagedown' || (key.name === 'd' && key.ctrl)) {
      scrollOffset = Math.min(maxOffset, scrollOffset + pageSize);
    } else if (key.name === 'pageup' || (key.name === 'u' && key.ctrl)) {
      scrollOffset = Math.max(0, scrollOffset - pageSize);
    }

    // Home/End
    if (key.name === 'home' || char === 'g') {
      scrollOffset = 0;
    } else if (key.name === 'end' || char === 'G') {
      scrollOffset = maxOffset;
    }
  });

  const result = await p.prompt();
  // isCancel means they pressed escape/ctrl-c — that's fine too
  if (isCancel(result)) return;
}
