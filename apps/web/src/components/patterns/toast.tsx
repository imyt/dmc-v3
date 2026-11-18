import { UNSTABLE_Toast as Toast, UNSTABLE_ToastContent as ToastContent, UNSTABLE_ToastQueue as ToastQueue, UNSTABLE_ToastRegion as ToastRegion, Button, Text } from 'react-aria-components';
import { X } from '@phosphor-icons/react';

export interface ToastValue { title: string; description?: string; tone?: 'success' | 'error' | 'info' }

/** P19. The result of an action. Work that needs someone goes to the inbox, never to a toast. */
export const toasts = new ToastQueue<ToastValue>({ maxVisibleToasts: 3 });
export const notify = (v: ToastValue, timeout = v.tone === 'error' ? undefined : 6000) => toasts.add(v, timeout ? { timeout } : undefined);

const BORDER = { success: 'border-l-success', error: 'border-l-destructive', info: 'border-l-info' } as const;

export function ToastHost() {
  return (
    <ToastRegion queue={toasts} className="fixed right-4 bottom-4 z-50 flex flex-col gap-2">
      {({ toast }) => (
        <Toast toast={toast} className={`flex w-80 items-start gap-3 border border-l-4 border-border bg-popover p-3 shadow-md ${BORDER[toast.content.tone ?? 'info']}`}>
          <ToastContent className="flex-1">
            <Text slot="title" className="block font-semibold">{toast.content.title}</Text>
            {toast.content.description && <Text slot="description" className="block text-sm text-muted-foreground">{toast.content.description}</Text>}
          </ToastContent>
          <Button slot="close" aria-label="Dismiss" className="p-1"><X aria-hidden className="size-4" /></Button>
        </Toast>
      )}
    </ToastRegion>
  );
}
