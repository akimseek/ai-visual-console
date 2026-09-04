import type { AiSession } from '../types';
import { SessionDetailModal } from '../features/sessions/session-detail-modal';
import { SessionContextMenu, TabContextMenu } from '../features/terminal/context-menus';
import type { BranchPanelState } from '../features/sessions/branch-panel';
import type { ConversationTurn } from '../features/sessions/conversation';

export type SessionContextMenuState = {
  x: number;
  y: number;
  session: AiSession;
  view: 'active' | 'trash';
};

export type TabContextMenuState = {
  x: number;
  y: number;
  tabKey: string;
};

type WorkspaceOverlaysProps = {
  detailDialogSession: AiSession | null;
  selectedSessionDetails: AiSession | null;
  selectedSessionLoading: boolean;
  branchPanel: BranchPanelState | null;
  detailHasMore: boolean;
  detailLoadingMore: boolean;
  supportsBranch: boolean;
  onLoadMore: () => Promise<void>;
  onCloseDetail: () => void;
  onOpenSession: (session: AiSession) => void;
  onBranchFromTurn: (session: AiSession, turn: ConversationTurn) => void;
  contextMenu: SessionContextMenuState | null;
  supportsTrash: boolean;
  supportsDuplicate: boolean;
  onRename: (session: AiSession) => void;
  onDuplicate: (session: AiSession) => void;
  onOpenFolder: (session: AiSession) => void;
  onRestore: (session: AiSession) => void;
  onPurge: (session: AiSession) => void;
  onDelete: (session: AiSession) => void;
  onCloseContextMenu: () => void;
  tabContextMenu: TabContextMenuState | null;
  tabCount: number;
  onCloseTab: (tabKey: string) => void;
  onCloseOtherTabs: (tabKey: string) => void;
  onCloseAllTabs: () => void;
  onCloseTabContextMenu: () => void;
};

/** 工作区浮层展示层：集中详情弹框和两个右键菜单，业务动作由页面传入。 */
export function WorkspaceOverlays({
  detailDialogSession,
  selectedSessionDetails,
  selectedSessionLoading,
  branchPanel,
  detailHasMore,
  detailLoadingMore,
  supportsBranch,
  onLoadMore,
  onCloseDetail,
  onOpenSession,
  onBranchFromTurn,
  contextMenu,
  supportsTrash,
  supportsDuplicate,
  onRename,
  onDuplicate,
  onOpenFolder,
  onRestore,
  onPurge,
  onDelete,
  onCloseContextMenu,
  tabContextMenu,
  tabCount,
  onCloseTab,
  onCloseOtherTabs,
  onCloseAllTabs,
  onCloseTabContextMenu
}: WorkspaceOverlaysProps) {
  return (
    <>
      {detailDialogSession && (
        <SessionDetailModal
          session={detailDialogSession}
          selectedSessionDetails={selectedSessionDetails}
          loading={selectedSessionLoading}
          branchPanel={branchPanel}
          hasMore={detailHasMore}
          loadingMore={detailLoadingMore}
          onLoadMore={onLoadMore}
          supportsBranch={supportsBranch}
          onClose={onCloseDetail}
          onOpenSession={onOpenSession}
          onBranchFromTurn={onBranchFromTurn}
        />
      )}
      {contextMenu && (
        <SessionContextMenu
          menu={contextMenu}
          supportsTrash={supportsTrash}
          canDuplicate={contextMenu.view === 'active' && supportsDuplicate}
          onRename={() => onRename(contextMenu.session)}
          onDuplicate={() => onDuplicate(contextMenu.session)}
          onOpenFolder={() => onOpenFolder(contextMenu.session)}
          onRestore={() => onRestore(contextMenu.session)}
          onPurge={() => onPurge(contextMenu.session)}
          onDelete={() => onDelete(contextMenu.session)}
          onClose={onCloseContextMenu}
        />
      )}
      {tabContextMenu && (
        <TabContextMenu
          menu={tabContextMenu}
          canCloseOthers={tabCount > 1}
          canCloseAll={tabCount > 0}
          onCloseTab={() => onCloseTab(tabContextMenu.tabKey)}
          onCloseOthers={() => onCloseOtherTabs(tabContextMenu.tabKey)}
          onCloseAll={onCloseAllTabs}
          onDismiss={onCloseTabContextMenu}
        />
      )}
    </>
  );
}
