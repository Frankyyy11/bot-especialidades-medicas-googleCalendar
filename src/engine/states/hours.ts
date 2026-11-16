import { M } from '../messages.js';
import type { Outgoing, Session } from '../types.js';
import { resetFlow, type EngineContext } from './common.js';

export function showHoursAndLocation(ctx: EngineContext, s: Session): Outgoing[] {
  resetFlow(s);
  return [M.hours(ctx.clinic), M.anythingElse()];
}
