'use client';

import { useRef, type ReactNode } from 'react';
import { formatBytes, totalBytes, type LocalMaterialMeta } from '@/lib/localMaterials';
import { MaterialThumb } from '@/components/MaterialThumb';
import { useCompactEditor } from '@/components/useCompactEditor';
import type { LocalMaterialsState, LocalStatusSlot } from '@/components/useLocalMaterials';

interface Props {
  /** 状态由调用方持有（useLocalMaterials），切 tab 重新挂载时不会重读 IndexedDB */
  state: LocalMaterialsState;
  /** 只交出不透明元数据：包成 Background 还是 ImageBlock 由调用方决定 */
  onSelect: (meta: LocalMaterialMeta) => void;
  /** 行首的分段标签（图片/视频/本地），不属于本组件的语义 */
  leading?: ReactNode;
  /** 空库时的说明文案，各调用方对「缺图会怎样」的描述不一样 */
  emptyHint: ReactNode;
}

/** 状态槽：桌面固定占一行高（有没有消息都不改整条高度，切 tab 时不跳版）；手机端宁可长一行也要把话说完 */
export function StatusSlot({ slot }: { slot: LocalStatusSlot | null }) {
  const compact = useCompactEditor();
  return (
    <div
      className={`${compact ? 'min-h-5 leading-snug py-0.5' : 'h-5 leading-5 truncate'} text-[11px] ${slot?.cls ?? ''}`}
      title={slot?.text}
    >
      {slot?.text}
    </div>
  );
}

/**
 * 「📁 本地」整条：入口按钮 + 用量 + 状态槽 + 单行预览网格 + 隐藏 file input。
 * 全部走浏览器（IndexedDB + File System Access），一个字节都不上服务器。
 */
export function LocalMaterialPicker({ state, onSelect, leading, emptyHint }: Props) {
  const status = state.status ?? (state.folderSupported ? null : state.unsupportedHint);
  const inputRef = useRef<HTMLInputElement>(null);
  const compact = useCompactEditor();

  /** 手机端那一行放不下文件夹名，名字交给右侧用量那段显示；桌面按原来的完整说法 */
  const folderText = !state.folder
    ? compact ? '📁 文件夹' : '📁 选择素材文件夹'
    : state.folder.permission === 'granted'
      ? compact ? '🔄 扫描' : `🔄 扫描「${state.folder.name}」`
      : compact ? '🔓 授权' : `🔓 重新授权「${state.folder.name}」`;

  /** 四个控件加用量：桌面直接躺在那条横滚行里，手机端被包进一条不许换行的行 */
  const controls = (
    <>
      <button
        onClick={() => inputRef.current?.click()}
        disabled={state.busy}
        className={`rounded bg-green-600 hover:bg-green-500 disabled:bg-gray-600 transition shrink-0 ${
          compact ? 'h-9 px-2.5 text-xs' : 'px-3 py-1 text-xs'
        }`}
        title="挑几张本机图片/视频加进本地库，字节只写进这台设备的浏览器，不上传服务器"
      >
        {compact ? '＋ 本机文件' : '＋ 选择本机文件（不进服务器）'}
      </button>
      {state.folderSupported && (
        <button
          onClick={() => void state.handleFolderClick()}
          disabled={state.busy}
          className={`rounded bg-green-600 hover:bg-green-500 disabled:bg-gray-600 transition shrink-0 ${
            compact ? 'h-9 px-2.5 text-xs' : 'max-w-[11rem] truncate px-3 py-1 text-xs'
          }`}
          title={
            state.folder
              ? state.folder.permission === 'granted'
                ? `扫描「${state.folder.name}」这一层（不含子文件夹），把新放进去的图片/视频补进本地库`
                : `重新打开网页后浏览器会忘记「${state.folder.name}」，点一下重新授权，之后照常扫描`
              : '选一个本机文件夹，之后把素材丢进去就行；文件只复制进这台设备的浏览器，不上传服务器'
          }
        >
          {folderText}
        </button>
      )}
      {state.folder && (
        <button
          onClick={() => void state.handleForgetFolder()}
          disabled={state.busy}
          className={`rounded bg-white/10 hover:bg-white/20 disabled:opacity-50 transition shrink-0 ${
            compact ? 'h-9 px-2.5 text-xs' : 'px-2 py-1 text-xs'
          }`}
          title="断开这个文件夹（已入库的素材保留）"
        >
          ✕
        </button>
      )}
      <button
        onClick={() => void state.loadLocalList()}
        disabled={state.busy}
        className={`rounded bg-white/10 hover:bg-white/20 disabled:opacity-50 transition shrink-0 ${
          compact ? 'h-9 px-2 text-xs' : 'px-3 py-1 text-xs'
        }`}
        title="重新读取本地素材库"
      >
        ⟳
      </button>

      <div className={`text-[10px] text-gray-500 ${compact ? 'ml-auto min-w-0 truncate text-right' : 'ml-auto shrink-0'}`}>
        {state.folder ? (compact ? `「${state.folder.name}」 · ` : `已连接「${state.folder.name}」 · `) : ''}
        {state.localList.length > 0
          ? `${compact ? '' : '共 '}${state.localList.length} 项 · ${formatBytes(totalBytes(state.localList))}`
          : '素材只存在当前浏览器'}
      </div>
    </>
  );

  return (
    <div className="border border-white/10 rounded-lg p-2 bg-[#0a0a12]">
      {/* 桌面：分段标签和入库按钮共用一条固定行高的行，装不下就横滚。手机端：标签自己一行，四个控件压成一条不换行的行 */}
      <div
        className={
          compact
            ? 'flex flex-col gap-1.5 py-1'
            : 'bg-strip-scroll flex items-center gap-2 h-8 shrink-0 overflow-x-auto overflow-y-hidden'
        }
      >
        {leading}
        {compact ? <div className="flex items-center gap-1.5">{controls}</div> : controls}
      </div>

      <StatusSlot slot={status} />

      {/* 预览区：桌面固定单行横滚；手机端一排 2 个竖向排，整块跟着编辑窗往下滚，不留下面那片空白 */}
      <div className={compact ? 'mt-1' : 'mt-1 h-[100px] shrink-0'}>
        {state.localLoading ? (
          <div
            className={`${compact ? 'py-5' : 'h-full'} flex items-center justify-center text-gray-400 text-xs`}
          >
            ⏳ 读取本地素材库...
          </div>
        ) : state.localList.length === 0 ? (
          <div
            className={`text-xs text-gray-400 p-2 bg-white/5 rounded ${
              compact ? 'leading-snug' : 'bg-strip-scroll h-full overflow-y-auto'
            }`}
          >
            {emptyHint}
          </div>
        ) : (
          <div
            className={
              compact
                ? 'grid grid-cols-2 gap-2'
                : 'bg-strip-scroll flex gap-2 h-full overflow-x-auto overflow-y-hidden'
            }
          >
            {state.localList.map((meta) => (
              <MaterialThumb
                key={meta.key}
                meta={meta}
                grid={compact}
                onPick={() => onSelect(meta)}
                onRemove={() => void state.handleRemove(meta)}
              />
            ))}
          </div>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={state.acceptAttr}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void state.handlePickFile(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}
