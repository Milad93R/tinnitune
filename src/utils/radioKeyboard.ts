import type { KeyboardEvent } from 'react';

export function handleRadioKeyDown(event: KeyboardEvent<HTMLElement>) {
  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)'));
  const index = buttons.indexOf(event.target as HTMLButtonElement);
  if (index < 0) return;

  let nextIndex: number;
  switch (event.key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      nextIndex = (index + buttons.length - 1) % buttons.length;
      break;
    case 'ArrowRight':
    case 'ArrowDown':
      nextIndex = (index + 1) % buttons.length;
      break;
    case 'Home':
      nextIndex = 0;
      break;
    case 'End':
      nextIndex = buttons.length - 1;
      break;
    default:
      return;
  }

  event.preventDefault();
  buttons[nextIndex].focus();
  buttons[nextIndex].click();
}
