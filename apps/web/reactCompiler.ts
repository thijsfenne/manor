import path from 'node:path'
import type { BabelOptions } from '@vitejs/plugin-react'
import reactCompiler from 'babel-plugin-react-compiler'

/**
 * Files the React Compiler compiles, relative to apps/web. The list is strict: a listed
 * file compiles every component and hook in it, and carries no manual `useMemo` or
 * `useCallback`, because the compiler memoizes those itself. A bailout fails the build
 * (`panicThreshold`); `test/reactCompiledFiles.test.ts` names the rule that broke.
 *
 * Add a file once it compiles cleanly and its manual memoization is gone, in the same
 * change. `memo()` stays where a parent re-renders with a row's props unchanged: the
 * compiler caches what a component returns, not whether it runs.
 */
export const REACT_COMPILED_FILES: readonly string[] = [
  // The conversation: rows, bubbles and a turn's activity.
  'src/components/Transcript.tsx',
  'src/components/Bubbles.tsx',
  'src/components/mentionMarkdown.tsx',
  'src/components/TurnActivity.tsx',
  'src/components/TurnStatus.tsx',
  'src/components/MessageFooter.tsx',
  'src/components/DmWorkingIndicator.tsx',
  'src/components/Avatar.tsx',
  'src/useStableCallback.ts',
  // The pane around it and the composer: the pane reads the quiet workspace, so a streamed
  // token re-renders neither; only the transcript reads the live thread.
  'src/components/ChatPane.tsx',
  'src/components/Composer.tsx',
  'src/components/ComposerEditor.tsx',
  'src/components/NewChatModeControl.tsx',
  'src/components/RuntimeControls.tsx',
  'src/components/RuntimeLabel.tsx',
  'src/components/SingleRuntimeControl.tsx',
  'src/components/ContextRing.tsx',
  'src/components/AskCard.tsx',
  'src/components/WorkDecisionDock.tsx',
  'src/components/WorkspaceHeader.tsx',
  'src/components/RightRail.tsx',
  // The shell: every structural push re-renders Workspace, and its JSX now holds still.
  'src/App.tsx',
  'src/components/workspace/ChatStage.tsx',
  'src/components/workspace/WorkspaceDialogs.tsx',
  'src/components/workspace/WorkspaceNavRail.tsx',
  'src/components/NavRail.tsx',
  'src/components/TopBar.tsx',
  'src/components/ProviderUpdates.tsx',
  'src/components/session/SessionGitToast.tsx',
  'src/components/BrowserWebviewHost.tsx',
  'src/useRevealRequests.ts',
  'src/components/fileMark.tsx',
  // The sidebar and its rows.
  'src/components/Sidebar.tsx',
  'src/components/chats/ChatListView.tsx',
  'src/components/inbox/Standing.tsx',
  'src/components/ui/RoleBadge.tsx',
  'src/components/ui/SelectionMarker.tsx',
  // Leaves every one of those draws.
  'src/components/Icon.tsx',
  'src/components/ui/IconButton.tsx',
  'src/components/ui/IconSwap.tsx',
  'src/components/ui/Popover.tsx',
  'src/components/ui/Menu.tsx',
]

/**
 * Functions declared pure to the compiler: the answer depends on the arguments alone (no
 * clock, storage or module state), and the arguments come back untouched. Keyed by the
 * import path without its leading `./` and `../`, with the file it resolves to. Each name
 * is audited by hand; a function a compiled file imports that is not listed keeps the
 * compiler's own cautious reading, so adding one here is the moment to check it. `state`
 * also exports clock readers (`snoozeUntilTomorrow`), which stay off the list.
 *
 * The compiler cannot see into an import, so it assumes any call may mutate what it was
 * given. One such call late in a component ties every value it touched to the end of the
 * render, and the component memoizes as one block that a streamed token invalidates.
 * Declared pure, each value caches on its own inputs instead.
 */
export const PURE_MODULES: Readonly<Record<string, { file: string; functions: readonly string[] }>> = {
  state: {
    file: 'src/state.ts',
    functions: [
      'answerTextOf', 'canUnsettle', 'changeableAnswers', 'chatListPins', 'chatOf',
      'dmMemoryMarks', 'feedIndexOf', 'finishedSilent',
      'goalReportEventId', 'isHomeRoom', 'isProjectThread', 'liveWritten', 'roomOf',
      'messageBrief', 'onlyConsulted', 'openAsk', 'openThreadBundleAt', 'openThreadQuestion',
      'openWorkDecisions', 'participantIds', 'personaOf', 'projectThreadFeed',
      'projectWorkHandoffs', 'railPins', 'relayExchanges', 'relayMarkerAction', 'repoListingKey', 'rowHasQuoteSource', 'rowsOf',
      'runtimeStartedAgentIds', 'sessionLiveOf', 'sessionReadyRow', 'sessionThreadOf',
      'setThreadBundleOpen', 'sitsSettled', 'stackedConsultationMarkers', 'streamedMessages',
      'threadBundleOpen', 'threadBundleOpenItems', 'threadOf', 'threadQuestionAdvice',
      'threadSpacing', 'threadStretch', 'unannouncedConsultations', 'withSessionTitle',
      'workCardInView', 'workConfirmTitle', 'workResultActionLabels',
    ],
  },
  mentions: {
    file: 'src/mentions.ts',
    functions: [
      'activeImageRef', 'activeMention', 'activeSkill', 'applyImageRef', 'applyMention',
      'applySkill', 'chatFallbackTargets', 'composerRecipients', 'composerShowsRecipients', 'draftRecipients',
      'eligibleSkills', 'insertTrigger', 'matchAgents', 'matchFiles', 'matchImageRefs',
      'matchSkills', 'matchesBrowserMention', 'matchesWorkMention', 'mentionSegments',
      'parseMentions', 'remarkAgentMentions', 'remarkMessageChips', 'remarkSoftBreaks',
      'replyFallbackTargets', 'roomAgents', 'shieldFileChips', 'shieldMessageRefs',
    ],
  },
  turnTrace: {
    file: 'src/turnTrace.ts',
    functions: [
      'activeCall', 'activityBlocks', 'backgroundStillRunning', 'backgroundWaitLabel',
      'chatWaitsOnBackground', 'dmWorking',
      'dmWorkingLabel', 'groupLabel', 'hasFold', 'hasStatus', 'isCompactNote',
      'isCompacting', 'isPaused', 'isSettledCompactNote', 'isSubagentStep', 'isWaiting',
      'shownSegments', 'stepDetail', 'stepImages', 'stepLabel', 'thumbnailStrip', 'traceRows', 'turnSummary',
    ],
  },
  turnLabels: {
    file: 'src/turnLabels.ts',
    functions: [
      'currentLabel', 'elapsedLabel', 'isEditTool', 'isReadTool', 'isSearchTool', 'isShellTool',
      'wakeLines', 'workSummary', 'workedLabel',
    ],
  },
  runtimeChoices: {
    file: 'src/runtimeChoices.ts',
    functions: [
      'activeEffort', 'activeModel', 'activeSpeed', 'defaultSingleRuntime', 'differsFromRoster',
      'effectiveDriver', 'isAutoOn', 'isAutoPending', 'isSingleDriver', 'readSingleRuntime',
      'runtimeParts', 'singleRuntimeVoice', 'withAuto',
    ],
  },
  chatRoster: {
    file: 'src/chatRoster.ts',
    functions: [
      'chatRoster',
    ],
  },
  splitStage: {
    file: 'src/splitStage.ts',
    functions: [
      'chatOnStage', 'focusedSplitChatId', 'occupiedSplitIds', 'splitPaneContentWidth',
    ],
  },
  navDestination: {
    file: 'src/navDestination.ts',
    functions: [
      'navDestinationOf', 'sidebarPanelOf',
    ],
  },
  lastProject: {
    file: 'src/lastProject.ts',
    functions: [
      'lastCreatedProjectId',
    ],
  },
  changedFiles: {
    file: 'src/changedFiles.ts',
    functions: [
      'turnChangedFiles',
    ],
  },
  '@manor/client-runtime/state': {
    file: '../../packages/client-runtime/src/state.ts',
    functions: [
      'fileWriteGroups',
    ],
  },
  '@manor/client-runtime/avatar-bubble': {
    file: '../../packages/client-runtime/src/avatarBubble.ts',
    functions: [
      'avatarBubbleTint', 'projectBubbleTint',
    ],
  },
  '@manor/client-runtime/context-meter': {
    file: '../../packages/client-runtime/src/contextMeter.ts',
    functions: [
      'contextBreakdown', 'contextProvenance', 'liveSessionContext', 'readContextMeter',
      'singleWorkContext',
    ],
  },
  '@manor/client-runtime/history-window': {
    file: '../../packages/client-runtime/src/historyWindow.ts',
    functions: [
      'historyStart', 'olderHistoryKey',
    ],
  },
  '@manor/client-runtime/message-quotes': {
    file: '../../packages/client-runtime/src/messageQuotes.ts',
    functions: [
      'quoteAuthorName', 'quoteFromText', 'quoteNamesAuthor',
    ],
  },
}

/** The `PURE_MODULES` key an import path falls under. */
export const pureModuleKey = (specifier: string) => specifier.replace(/^(\.\.?\/)+/, '')

/**
 * Reads its arguments and returns a fresh value, which the compiler then caches on those
 * arguments. A selector that hands back a piece of its input instead (`SELECTORS`) needs
 * no cache: the piece keeps its identity, and a frozen answer ties up nothing after it.
 */
const PURE_FUNCTION = {
  kind: 'function',
  positionalParams: [],
  restParam: 'read',
  calleeEffect: 'read',
  returnType: { kind: 'type', name: 'MixedReadonly' },
  returnValueKind: 'mutable',
} as const
const SELECTOR = { ...PURE_FUNCTION, returnValueKind: 'frozen' } as const
const SELECTORS = new Set(['threadOf', 'chatOf', 'roomOf', 'streamedMessages'])

/** React 18 needs the `react-compiler-runtime` package for the compiler's cache hook. */
export function reactCompilerOptions() {
  return {
    target: '18',
    panicThreshold: 'all_errors',
    environment: {
      moduleTypeProvider: (specifier: string) => {
        const functions = PURE_MODULES[pureModuleKey(specifier)]?.functions
        return functions === undefined ? null : {
          kind: 'object',
          properties: Object.fromEntries(functions.map((name) => [name, SELECTORS.has(name) ? SELECTOR : PURE_FUNCTION])),
        }
      },
    },
  } as const
}

/** Babel options for `@vitejs/plugin-react`: the compiler for listed files, nothing for the rest. */
export function reactCompilerBabel(root: string): (id: string) => BabelOptions {
  const compiled = new Set(REACT_COMPILED_FILES.map((file) => path.resolve(root, file)))
  const options = reactCompilerOptions()
  return (id) => compiled.has(id.split('?')[0]!)
    ? { plugins: [[reactCompiler, options]] }
    : {}
}
