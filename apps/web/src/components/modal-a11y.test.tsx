// R6: F-A11Y — the dialog manages focus: initial focus inside, Tab trap,
// focus restore on close, and aria-labelledby on the title.
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal, Button } from './ui';

afterEach(cleanup);

describe('modal focus management (F-A11Y)', () => {
  it('moves focus into the dialog and labels it from the title', () => {
    render(
      <Modal open onClose={() => undefined} title="Confirm action">
        <Button onClick={() => undefined}>Inside button</Button>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    const title = screen.getByText('Confirm action');
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('keeps Tab inside the dialog', async () => {
    const user = userEvent.setup();
    render(
      <Modal open onClose={() => undefined} title="Trap">
        <Button onClick={() => undefined}>First</Button>
        <Button onClick={() => undefined}>Second</Button>
      </Modal>,
    );
    const buttons = screen.getAllByRole('button', { name: /First|Second/ });
    buttons[0]!.focus();
    await user.tab();
    expect(document.activeElement).toBe(buttons[1]);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close dialog' }));
    await user.tab();
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('restores focus to a focused opener after a real open-and-close (TI-40)', async () => {
    const user = userEvent.setup();
    let rendered = false;
    function Harness() {
      const [open, setOpen] = React.useState(false);
      rendered = true;
      void rendered;
      return (
        <div>
          <button data-testid="opener" onClick={() => setOpen(true)}>
            open
          </button>
          {open && (
            <Modal open onClose={() => setOpen(false)} title="Restore">
              <button>inside</button>
            </Modal>
          )}
        </div>
      );
    }
    render(<Harness />);
    const opener = screen.getByTestId('opener');
    opener.focus();
    // Open from the focused opener: the dialog must take focus.
    await user.click(opener);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    // Close and require focus back on the opener (T1 mutation removes the
    // restore and leaves focus nowhere).
    await user.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
