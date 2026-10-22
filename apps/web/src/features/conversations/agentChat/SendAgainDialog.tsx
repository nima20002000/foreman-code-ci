import type { Dispatch, SetStateAction } from 'react'
import { Button, CodeBlock, Dialog, Select } from '../../../shared/ui/nocturne'
import { MessageFileCards, type MessageFileCardsProps } from '../../file-cards'
import type { useAgentConversationComposer } from './useAgentConversationComposer'

type Composer = ReturnType<typeof useAgentConversationComposer>
type SendAgain = NonNullable<Composer['sendAgain']>

/** Confirms sending an uncertain message again as a new message, or re-applying a session command. */
export function SendAgainDialog({ composer, reason, fileClient, files }: {
  composer: Pick<Composer, 'sendAgain' | 'resendCommand' | 'resendControl' | 'resendPending' | 'submit'> & {
    setSendAgain: Dispatch<SetStateAction<SendAgain | undefined>>
  }
  reason?: string
  fileClient?: MessageFileCardsProps['client']
  files: MessageFileCardsProps['files']
}) {
  const { sendAgain, setSendAgain, resendCommand, resendControl, resendPending, submit } = composer
  const needsMode = resendCommand.kind === 'message'
  return <Dialog open={sendAgain !== undefined} onOpenChange={(open) => { if (!open) setSendAgain(undefined) }}
    title={resendControl ? 'Apply session command again?' : 'Send again as a new message?'}
    description={resendControl ? 'This applies the command to the chat session again. Attached files are not sent.'
      : 'The first send may already have gone through. This sends a new copy and can repeat work.'}
    dismissible={!resendPending} busy={resendPending} role="alertdialog" size="sm">
    {sendAgain ? <div className="n-stack agent-chat-send-again">
      <CodeBlock label="Message" code={sendAgain.content} />
      {needsMode ? <Select label="Mode" value={sendAgain.sessionMode ?? ''}
        hint={sendAgain.sessionMode ? undefined : 'The original mode is unknown. Choose one.'}
        options={[{ value: '', label: 'Choose a mode', disabled: true }, { value: 'regular', label: 'Regular' }, { value: 'plan', label: 'Plan' }]}
        onChange={event => {
          if (event.target.value === 'regular' || event.target.value === 'plan') setSendAgain({ ...sendAgain, sessionMode: event.target.value })
        }} /> : null}
      {resendCommand.kind === 'plan-task' ? <p>Mode: Plan</p> : null}
      {!resendControl && sendAgain.attachments?.length && fileClient
        ? <MessageFileCards attachments={sendAgain.attachments} files={files} client={fileClient} /> : null}
      {reason ? <p className="n-field-error" role="alert">{reason}</p> : null}
      <div className="n-actions">
        <Button disabled={resendPending} onClick={() => setSendAgain(undefined)}>Cancel</Button>
        <Button variant="primary" loading={resendPending}
          disabled={resendPending || !!reason || needsMode && !sendAgain.sessionMode}
          onClick={() => {
            void submit('next_turn', sendAgain.content, sendAgain.sessionMode, { attachments: sendAgain.attachments })
              .then(sent => { if (sent) setSendAgain(current => current === sendAgain ? undefined : current) })
          }}>{resendControl ? 'Apply again' : 'Send again'}</Button>
      </div>
    </div> : null}
  </Dialog>
}
