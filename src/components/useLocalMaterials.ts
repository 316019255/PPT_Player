'use client';

import { useMemo, useState } from 'react';
import {
  authorizeFolder,
  forgetFolder,
  getFolderStatus,
  listMaterials,
  pickFolder,
  putMaterial,
  removeMaterial,
  scanFolder,
  supportsFolderPicker,
  type FolderScanProgress,
  type FolderStatus,
  type LocalMaterialMeta,
} from '@/lib/localMaterials';
import { storedImageExt, storedVideoExt } from '@/lib/media-ext';

export type MaterialAccept = 'all' | 'image' | 'video';

export interface LocalStatusSlot {
  text: string;
  cls: string;
}

/** 浏览器判断不了时的兜底文案用得到：只有位图白名单里的才算图片 */
function isImageFile(file: File): boolean {
  if (file.type === 'image/svg+xml') return false;
  if (file.type.startsWith('image/')) return true;
  return storedImageExt(file.name) !== null;
}

/** 同上，但只认视频白名单里的后缀和类型 */
function isVideoFile(file: File): boolean {
  if (file.type.startsWith('video/')) return true;
  return storedVideoExt(file.name) !== null;
}

/**
 * 本地素材库（IndexedDB）的一份状态：读库、单文件入库、连接文件夹与扫描。
 *
 * 状态放在调用方（背景条 / 插图条）而不是格子里，切 tab 时才不会丢：
 * 重新挂载会再读一次 IndexedDB，几百项时界面会闪一下。
 */
export function useLocalMaterials(options: { accept: MaterialAccept; onPicked?: (meta: LocalMaterialMeta) => void }) {
  const { accept, onPicked } = options;

  const [localList, setLocalList] = useState<LocalMaterialMeta[]>([]);
  const [localLoading, setLocalLoading] = useState(false);
  const [localLoaded, setLocalLoaded] = useState(false);
  /** 正在生成本地预览的文件名；解视频首帧可能要几秒 */
  const [importing, setImporting] = useState('');

  /** 只在进入本地模式之后才有值，避免 SSR 与客户端对 window API 的判断不一致 */
  const [folderSupported, setFolderSupported] = useState(false);
  const [folder, setFolder] = useState<FolderStatus | null>(null);
  const [scan, setScan] = useState<FolderScanProgress | null>(null);
  const [scanNote, setScanNote] = useState('');
  const [feedback, setFeedback] = useState('');

  const visibleList = useMemo(() => {
    if (accept === 'image') return localList.filter((m) => m.kind === 'image');
    if (accept === 'video') return localList.filter((m) => m.kind === 'video');
    return localList;
  }, [accept, localList]);

  const loadLocalList = async () => {
    setLocalLoading(true);
    setFeedback('');
    try {
      setLocalList(await listMaterials());
      setLocalLoaded(true);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : '读取本地素材库失败');
    } finally {
      setLocalLoading(false);
    }
  };

  /** 扫描已连接的文件夹；库里已有的直接跳过，不重新解码，所以多点几次不贵 */
  const runScan = async () => {
    setScanNote('');
    setFeedback('');
    try {
      const report = await scanFolder(setScan);
      // 一趟全库读只为拿列表：这一批没新增就说明库里和文件夹一致，不必再读一次
      if (report.added.length) await loadLocalList();
      const parts = [`新增 ${report.added.length}`, `已存在 ${report.unchanged}`];
      if (report.unsupported) parts.push(`不是素材 ${report.unsupported}`);
      if (report.failed.length) parts.push(`失败 ${report.failed.length}（${report.failed[0].reason}）`);
      setScanNote(`📁 扫描完成 · ${parts.join(' · ')}`);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : '扫描文件夹失败');
    } finally {
      setScan(null);
    }
  };

  const refreshFolder = async () => {
    try {
      const status = await getFolderStatus();
      setFolder(status);
      // 权限还在（同一个页面会话里没重新打开过网页）就自动同步，用户只管往文件夹丢文件
      if (status?.permission === 'granted') await runScan();
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : '读取素材文件夹失败');
    }
  };

  /** 第一次进入本地模式才读 IndexedDB（纯客户端，不碰服务器） */
  const activate = () => {
    setFolderSupported(supportsFolderPicker());
    if (!localLoaded) void loadLocalList();
    void refreshFolder();
  };

  const handleFolderClick = async () => {
    setFeedback('');
    if (!folder) {
      try {
        const status = await pickFolder();
        setFolder(status);
        if (status.permission === 'granted') await runScan();
      } catch (err) {
        // 用户在系统目录选择框里点了取消
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setFeedback(err instanceof Error ? err.message : '选择文件夹失败');
      }
      return;
    }
    if (folder.permission !== 'granted') {
      const permission = await authorizeFolder();
      setFolder({ ...folder, permission });
      if (permission !== 'granted') {
        setFeedback('没有拿到这个文件夹的读取权限，重新选一次文件夹试试');
        return;
      }
    }
    await runScan();
  };

  /** 只是忘记文件夹，已经进了本地库的素材不动 */
  const handleForgetFolder = async () => {
    setFeedback('');
    try {
      await forgetFolder();
      setFolder(null);
      setScanNote('');
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : '断开文件夹失败');
    }
  };

  const handlePickFile = async (file: File) => {
    // 视频能进本地库，所以这一层也要挡：只过滤网格会让「选本机文件」把视频塞成图片块
    if (accept === 'image' && !isImageFile(file)) {
      setFeedback('这里只收图片');
      return;
    }
    if (accept === 'video' && !isVideoFile(file)) {
      setFeedback('这里只收视频（mp4 / webm / ogg / mov）');
      return;
    }
    setFeedback('');
    setImporting(file.name);
    try {
      const meta = await putMaterial(file);
      setLocalList((prev) => [meta, ...prev.filter((m) => m.key !== meta.key)]);
      onPicked?.(meta);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : '添加到本地素材库失败');
    } finally {
      setImporting('');
    }
  };

  const handleRemove = async (meta: LocalMaterialMeta) => {
    const fromFolder = folder
      ? `文件还留在「${folder.name}」里，下次扫描会重新出现，但会是新的引用——用它的背景会变回纯色。`
      : '';
    if (!confirm(`从本地素材库删除「${meta.name}」？文件只存在这台设备的这个浏览器里，删了找不回。${fromFolder}`)) return;
    setFeedback('');
    try {
      await removeMaterial(meta.key);
      setLocalList((prev) => prev.filter((m) => m.key !== meta.key));
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : '删除失败');
    }
  };

  /** 读库、单文件入库、文件夹扫描三件事都会动本地库，任一进行中时按钮全部锁住 */
  const busy = localLoading || importing !== '' || scan !== null;

  /** 状态槽一次只说一件事：错误 > 正在扫描 > 正在生成预览 > 上次扫描结果 */
  const status: LocalStatusSlot | null = feedback
    ? { text: `✗ ${feedback}`, cls: 'text-red-300' }
    : scan
      ? { text: `⏳ 正在扫描「${folder?.name ?? ''}」${scan.done}/${scan.total}：${scan.name}`, cls: 'text-gray-300' }
      : importing
        ? { text: `⏳ 正在为「${importing}」生成预览，视频要解一帧，请稍等…`, cls: 'text-gray-300' }
        : scanNote
          ? { text: scanNote, cls: 'text-gray-300' }
          : null;

  const unsupportedHint: LocalStatusSlot = {
    text: '📁 按文件夹导入需要 Chrome 或 Edge，当前浏览器没有这个接口；用「＋ 选择本机文件」照常可以逐个添加。',
    cls: 'text-gray-500',
  };

  return {
    localList: visibleList,
    localLoading,
    folderSupported,
    folder,
    busy,
    status,
    unsupportedHint,
    acceptAttr: accept === 'image' ? 'image/*' : accept === 'video' ? 'video/*' : 'image/*,video/*',
    activate,
    loadLocalList,
    handleFolderClick,
    handleForgetFolder,
    handlePickFile,
    handleRemove,
  };
}

export type LocalMaterialsState = ReturnType<typeof useLocalMaterials>;
