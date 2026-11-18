/**
 * What a chat's header and panel region show while a subagent view lies over it. The
 * subagent is not the Session: Settle, the panel doors and the environment panel
 * describe the Session, so they leave. Nothing is closed or reset, so they return as
 * they were once the view is closed.
 */
export function subagentChrome(subagentPath: readonly string[]) {
  const onStage = subagentPath.length > 0
  return { settle: !onStage, doors: !onStage, panelHidden: onStage }
}
