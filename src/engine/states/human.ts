import { M } from '../messages.js';
import type { Outgoing, Session } from '../types.js';
import { resetFlow, type EngineContext } from './common.js';

/** Pasa la conversación a recepción: el llamador debe pausar el bot (handoff). */
export function handOffToHuman(ctx: EngineContext, s: Session, urgent = false): Outgoing[] {
  resetFlow(s);
  s.state = 'HUMANO';
  return urgent ? [M.urgency(), M.urgencyHandoff()] : [M.human(ctx.clinic)];
}
