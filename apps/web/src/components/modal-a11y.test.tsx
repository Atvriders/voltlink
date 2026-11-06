// R6: F-A11Y — the dialog manages focus: initial focus inside, Tab trap,
// focus restore on close, and aria-labelledby on the title.
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('restores focus when the dialog closes', () => {
    const { rerender } = render(
      <div>
        <button data-testid="opener">open</button>
        <Modal open onClose={() => undefined} title="Restore">
          <span>body</span>
        </Modal>
      </div>,
    );
    const opener = screen.getByTestId('opener');
    opener.focus();
    rerender(
      <div>
        <button data-testid="opener">open</button>
        <Modal open={false} onClose={() => undefined} title="Restore">
          <span>body</span>
        </Modal>
      </div>,
    );
    expect(document.activeElement).toBe(opener);
  });
});
