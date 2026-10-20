'use client';

/* eslint-disable @next/next/no-img-element -- 预览的是用户刚填的外链地址或刚选的本机文件，next/image 需要预先固定的 remotePatterns，这里直接用 img */
import { memo, useEffect, useRef, useState } from 'react';
import type { MediaSource } from '@/types/ppt';
import type { MediaKind } from '@/lib/media-ext';
import { formatBytes, localRefValue } from '@/lib/localMaterials';
import { hasMediaBase, parseRemoteUrl } from '@/lib/media-source';
import { maxUploadBytesFor } from '@/lib/media-ext';
import { uploadMediaToCloud } from '@/lib/mediaClient';
import { LocalMaterialPicker, StatusSlot } from '@/components/LocalMaterialPicker';
import { useLocalMaterials, type LocalStatusSlot } from '@/components/useLocalMaterials';
import { useCompactEditor } from '@/components/useCompactEditor';

interface Props {
  kind: MediaKind;
  /** 只交出不透明来源；落在页面哪个位置、多大由调用方决定 */
  onInsert: (src: MediaSource, alt?: string) => void;
}

type TabType = 'local' | 'cloud' | 'url';

const LABEL: Record<MediaKind, string> = { image: '图片', video: '视频' };

/**
 * 「插媒体」整条：本机文件 / 本地素材库 / 云端 / 网络地址。
 * kind 决定只收图片还是视频，UI 文案和校验都跟着走。
 * 外壳高度与背景条逐行对齐（h-8 + h-5 + h-[100px]），切模式时画面不跳。
 */
export const MediaPicker = memo(function MediaPicker({ kind, onInsert }: Props) {
  const compact = useCompactEditor();
  const [tab, setTab] = useState<TabType>('local');
  const [url, setUrl] = useState('');
  const [previewFailed, setPreviewFailed] = useState(false);
  const label = LABEL[kind];

  const local = useLocalMaterials({
    accept: kind,
    onPicked: (meta) => onInsert({ kind: 'local', value: localRefValue(meta.key) }, meta.name),
  });

  // 背景条要靠点「📁 本地」才读库，这一条进来就是本地 tab，没有下一次点击，所以挂载即读。
  // activate 每次渲染都是新函数，放进依赖会反复重读，所以只取挂载时那一份。
  const activate = useRef(local.activate);
  useEffect(() => {
    void activate.current();
  }, []);

  const tabs = (
    <div className="flex gap-1 bg-white/5 rounded-lg p-1 shrink-0">
      <button
        onClick={() => setTab('local')}
        className={`text-xs rounded transition shrink-0 ${compact ? 'h-8 px-3' : 'px-2.5 py-1'} ${
          tab === 'local' ? 'bg-green-600 text-white' : 'text-gray-400 hover:text-white'
        }`}
        title="从你自己电脑里选，文件不会上传到服务器"
      >
        📁 本机 / 素材库
      </button>
      <button
        onClick={() => setTab('cloud')}
        className={`text-xs rounded transition shrink-0 ${compact ? 'h-8 px-3' : 'px-2.5 py-1'} ${
          tab === 'cloud' ? 'bg-purple-600 text-white' : 'text-gray-400 hover:text-white'
        }`}
        title={`传到你自己的云端空间：换电脑、换浏览器、换网址放映都是同一个${label}`}
      >
        ☁️ 云端
      </button>
      <button
        onClick={() => setTab('url')}
        className={`text-xs rounded transition shrink-0 ${compact ? 'h-8 px-3' : 'px-2.5 py-1'} ${
          tab === 'url' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'
        }`}
        title={`填一个 https ${label}地址，放映时由观众的设备去取`}
      >
        🔗 网络地址
      </button>
    </div>
  );

  if (tab === 'local') {
    return (
      <LocalMaterialPicker
        state={local}
        leading={tabs}
        onSelect={(meta) => onInsert({ kind: 'local', value: localRefValue(meta.key) }, meta.name)}
        emptyHint={
          <>
            还没有本地{label}素材。点「📁 选择素材文件夹」挑一个目录，以后把{label}丢进这个文件夹、再扫描一次就自动出现在这里；
            临时加一个也可以用「＋ 选择本机文件」——{label}只保存在<b>当前这台设备的这个浏览器</b>里，不上传服务器。
            <div className="mt-1 text-gray-500">
              换设备 / 换浏览器 / 用另一个网址放映时，本地{label}会显示为「这台设备没有这个{label}」；要到处都能看到就改用「☁️ 云端」。
            </div>
          </>
        }
      />
    );
  }

  if (tab === 'cloud') {
    return <CloudTab kind={kind} leading={tabs} onInsert={onInsert} />;
  }

  const parsed = parseRemoteUrl(url);
  const status: LocalStatusSlot | null = parsed
    ? previewFailed
      ? { text: `⚠️ 这个${label}预览不出来（可能被对方站点拦了），仍然可以插入，放映时再试一次`, cls: 'text-yellow-300' }
      : null
    : url.trim()
      ? { text: '✗ 只接受 https 外链或本站绝对路径，且不能有空格', cls: 'text-red-300' }
      : null;

  const insert = () => {
    if (!parsed) return;
    onInsert({ kind: 'remote', value: parsed });
    setUrl('');
    setPreviewFailed(false);
  };

  return (
    <div className="border border-white/10 rounded-lg p-2 bg-[#0a0a12]">
      <div className={`bg-strip-scroll flex items-center gap-2 shrink-0 ${
        compact ? 'flex-wrap py-1.5' : 'h-8 overflow-x-auto overflow-y-hidden'
      }`}>
        {tabs}
        <input
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setPreviewFailed(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') insert();
          }}
          placeholder={kind === 'image' ? 'https://example.com/pic.png' : 'https://example.com/clip.mp4'}
          spellCheck={false}
          className={`rounded bg-white/5 border border-white/10 outline-none focus:border-blue-500 ${
            compact
              ? 'grow basis-48 min-w-0 h-11 px-2 text-base'
              : 'min-w-[16rem] flex-1 shrink-0 px-2 py-1 text-xs'
          }`}
        />
        <button
          onClick={insert}
          disabled={!parsed}
          className={`rounded bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 disabled:cursor-not-allowed transition shrink-0 ${
            compact ? 'h-11 px-4 text-base' : 'px-3 py-1 text-xs'
          }`}
        >
          插入这个
        </button>
      </div>

      <StatusSlot slot={status} />

      <div className="mt-1 h-[100px] shrink-0">
        <Preview kind={kind} url={parsed} onFailed={() => setPreviewFailed(true)} />
      </div>
    </div>
  );
});

/**
 * 「☁️ 云端」整条：选一个本机文件 → 传到你自己的桶 → 插进这一页。
 *
 * 字节不经过我们的服务器（Vercel 函数请求体约 4.5MB，一个课件文件就能超），
 * 服务器只签一个绑死单条路径的一次性地址，所以这里能给的进度只有「进行中」。
 * 同一份内容重复传不会重复占空间：路径按内容指纹走，命中「已存在」就直接引用。
 */
function CloudTab({ kind, leading, onInsert }: { kind: MediaKind; leading: React.ReactNode; onInsert: Props['onInsert'] }) {
  const compact = useCompactEditor();
  const [note, setNote] = useState<LocalStatusSlot | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<{ name: string; size: number; url: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** 上一次挂的那个 objectURL，换文件或卸载时要释放，不然选几个原文件就把内存吃住了 */
  const liveUrl = useRef('');
  const label = LABEL[kind];
  const maxMb = Math.round(maxUploadBytesFor(kind) / 1024 / 1024);

  const release = () => {
    if (liveUrl.current) URL.revokeObjectURL(liveUrl.current);
    liveUrl.current = '';
  };
  useEffect(() => release, []);

  const configured = hasMediaBase();

  const handleFile = async (file: File) => {
    release();
    const url = URL.createObjectURL(file);
    liveUrl.current = url;
    setPicked({ name: file.name, size: file.size, url });
    setBusy(true);
    setNote({ text: `⏳ 正在把「${file.name}」传上云端…`, cls: 'text-gray-300' });

    const result = await uploadMediaToCloud(file, kind);
    setBusy(false);

    if (!result.ok) {
      setNote({ text: `✗ ${result.reason}`, cls: 'text-red-300' });
      return;
    }
    setNote({
      text: result.reused
        ? `☁️ 「${file.name}」云端已经有同一份，直接引用，没有重复占空间`
        : `☁️ 「${file.name}」已传上云端，任何设备放映都能看到`,
      cls: 'text-green-300',
    });
    onInsert({ kind: 'cloud', value: result.path }, file.name);
  };

  return (
    <div className="border border-white/10 rounded-lg p-2 bg-[#0a0a12]">
      <div className={`bg-strip-scroll flex items-center gap-2 shrink-0 ${
        compact ? 'flex-wrap py-1.5' : 'h-8 overflow-x-auto overflow-y-hidden'
      }`}>
        {leading}
        <button
          onClick={() => inputRef.current?.click()}
          disabled={!configured || busy}
          className={`rounded bg-purple-600 hover:bg-purple-500 disabled:bg-gray-600 disabled:cursor-not-allowed transition shrink-0 ${
            compact ? 'h-11 px-4 text-sm' : 'px-3 py-1 text-xs'
          }`}
          title={
            configured
              ? `${label}会存进这个站点自己的云空间（单个不超过 ${maxMb}MB），之后换设备也能看到`
              : '云端存储还没配置好，先用 📁 本机 或 🔗 网络地址'
          }
        >
          ＋ 选{label}并传上云端
        </button>
        <div className="ml-auto shrink-0 text-[10px] text-gray-500">单个 ≤ {maxMb}MB</div>
      </div>

      <StatusSlot slot={configured ? note : { text: '✗ 这个站点还没配置云端存储，先用「📁 本机」或「🔗 网络地址」', cls: 'text-gray-400' }} />

      <div className="mt-1 h-[100px] shrink-0">
        {picked ? (
          <div className="h-full flex items-center gap-2 bg-white/5 rounded overflow-hidden p-1">
            {kind === 'image' ? (
              <img src={picked.url} alt="" className="h-full max-w-[45%] object-contain" decoding="async" />
            ) : (
              <video src={picked.url} className="h-full max-w-[45%] object-contain" muted playsInline preload="metadata" />
            )}
            <div className="min-w-0 flex-1 text-[11px] leading-snug text-gray-400">
              <div className="truncate text-gray-200" title={picked.name}>{picked.name}</div>
              <div>{formatBytes(picked.size)}</div>
              <div className="mt-1 text-gray-500">
                传好后按内容命名，同一份内容传第二次不会多占空间。云端{label}由放映的设备自己去取，放映时需要能上网。
              </div>
            </div>
          </div>
        ) : (
          <div className="h-full overflow-y-auto text-xs text-gray-400 p-2 bg-white/5 rounded leading-snug">
            还没有传过的{label}。点「＋ 选{label}并传上云端」挑一个本机文件：它会存进这个站点自己的云空间，
            幻灯片里记下的是它在云上的位置，不是它在你电脑上的路径 ——
            所以<b>换电脑、换浏览器、换个网址放映，看到的都是同一份</b>。
            <div className="mt-1 text-gray-500">只想留在本机就别传，用「📁 本机 / 素材库」，字节一个都不出这台设备。</div>
          </div>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={kind === 'image' ? 'image/*' : 'video/*'}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}

/**
 * 插之前先看见：地址合法就直接挂 <img>/<video>，取不到也只是显示「无预览」，
 * 不阻塞插入（有的站只拦热图 referer，放映时反而能出）。
 */
function Preview({ kind, url, onFailed }: { kind: MediaKind; url: string; onFailed: () => void }) {
  if (!url) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-gray-500">
        填好地址后这里会显示预览，确认是你要的那份再插入。
      </div>
    );
  }
  return (
    <div className="h-full flex items-center justify-center bg-white/5 rounded overflow-hidden">
      {kind === 'image' ? (
        <img
          src={url}
          alt=""
          className="h-full max-w-full object-contain"
          decoding="async"
          onError={onFailed}
        />
      ) : (
        <video
          src={url}
          className="h-full max-w-full object-contain"
          muted
          playsInline
          preload="metadata"
          onError={onFailed}
        />
      )}
    </div>
  );
}
