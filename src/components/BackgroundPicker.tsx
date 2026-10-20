'use client';

/* eslint-disable @next/next/no-img-element -- 缩略图来自任意第三方素材域名，next/image 需要固定的 remotePatterns/loader，这里直接用 img */
import { memo, useRef, useState } from 'react';
import type { Background } from '@/types/ppt';
import { cloudPublicUrl } from '@/lib/media-source';
import { storedVideoExt } from '@/lib/media-ext';
import type { LibraryMaterial } from '@/lib/materialLibrary';
import { localRefValue } from '@/lib/localMaterials';
import { useCompactEditor } from '@/components/useCompactEditor';
import { useInView } from '@/components/useInView';
import { LocalMaterialPicker, StatusSlot } from '@/components/LocalMaterialPicker';
import { useLocalMaterials } from '@/components/useLocalMaterials';

interface Props {
  /** materials 表里启用的那几条，由编辑器页面在服务端读 + 缓存后传进来 */
  online: LibraryMaterial[];
  onSelect: (bg: Background) => void;
}

type TabType = 'image' | 'video' | 'local';

export const BackgroundPicker = memo(function BackgroundPicker({ online, onSelect }: Props) {
  const compact = useCompactEditor();
  const [tab, setTab] = useState<TabType>('image');
  const [imgCat, setImgCat] = useState('全部');
  const [vidCat, setVidCat] = useState('全部');

  const local = useLocalMaterials({
    accept: 'all',
    onPicked: (meta) => onSelect({ type: 'local', value: localRefValue(meta.key), name: meta.name }),
  });

  const openLocalTab = () => {
    setTab('local');
    local.activate();
  };

  // 手机端手指够用：分段按钮抬到 32px 高、左右更宽；桌面保持原来的紧凑密度
  const tabBtn = (active: boolean, activeBg: string) =>
    `text-xs rounded transition shrink-0 ${compact ? 'h-8 px-3' : 'px-2.5 py-1'} ${
      active ? `${activeBg} text-white` : 'text-gray-400 hover:text-white'
    }`;

  const tabs = (
    <div className="flex gap-1 bg-white/5 rounded-lg p-1 shrink-0">
      <button onClick={() => setTab('image')} className={tabBtn(tab === 'image', 'bg-blue-600')}>
        🖼️ 图片
      </button>
      <button onClick={() => setTab('video')} className={tabBtn(tab === 'video', 'bg-blue-600')}>
        🎬 视频
      </button>
      <button
        onClick={openLocalTab}
        className={tabBtn(tab === 'local', 'bg-green-600')}
        title="从你自己电脑里选，文件不会上传到服务器"
      >
        📁 本地
      </button>
    </div>
  );

  if (tab === 'local') {
    return (
      <LocalMaterialPicker
        state={local}
        leading={tabs}
        onSelect={(meta) => onSelect({ type: 'local', value: localRefValue(meta.key), name: meta.name })}
        emptyHint={
          <>
            还没有本地素材。点「📁 选择素材文件夹」挑一个目录，以后把图片/视频丢进这个文件夹、再扫描一次就自动出现在这里；
            临时加一个也可以用「＋ 选择本机文件」——文件只保存在<b>当前这台设备的这个浏览器</b>里，不上传服务器，放映时直接读本机，速度快。
            <div className="mt-1 text-gray-500">换设备 / 换浏览器 / 用另一个网址打开时，本地背景会退化成纯色。</div>
          </>
        }
      />
    );
  }

  const onlineList = online.filter((m) => m.kind === tab);
  const chips = ['全部', ...Array.from(new Set(onlineList.map((m) => m.category)))];
  const wanted = tab === 'image' ? imgCat : vidCat;
  const activeCat = chips.includes(wanted) ? wanted : '全部';
  const shown = activeCat === '全部' ? onlineList : onlineList.filter((m) => m.category === activeCat);

  /** 两套外壳共用同一批格子，只是高度由谁定不一样 */
  const tiles = shown.map((item) => (
    <OnlineTile
      key={item.id}
      grid={compact}
      src={cloudPublicUrl(item.thumb) || item.thumb}
      title={item.title}
      kind={item.kind}
      onSelect={() =>
        onSelect(item.cloud ? { type: 'cloud', value: item.ref } : { type: item.kind, value: item.ref })
      }
    />
  ));

  return (
    <div className="border border-white/10 rounded-lg p-2 bg-[#0a0a12]">
      {/* 一行：分段标签 + 当前标签的分类筛选。桌面高度固定、装不下就横滚；手机端换成换行，不给横向拉杆 */}
      <div
        className={`bg-strip-scroll flex items-center gap-2 shrink-0 ${
          compact ? 'flex-wrap py-1' : 'h-8 overflow-x-auto overflow-y-hidden'
        }`}
      >
        {tabs}
        {chips.map((c) => (
          <button
            key={c}
            onClick={() => (tab === 'image' ? setImgCat(c) : setVidCat(c))}
            className={`text-xs rounded shrink-0 ${compact ? 'h-8 px-3' : 'px-2 py-0.5'} ${
              activeCat === c ? 'bg-blue-600' : 'bg-white/10 hover:bg-white/20'
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      <StatusSlot slot={local.status} />

      {/* 手机端一排 2 个竖向排、跟着编辑窗往下滚；桌面仍是那条固定单行高，横向滚出来才加载 */}
      {online.length === 0 ? (
        <div className="mt-2 text-xs text-gray-500 leading-relaxed">
          在线素材暂时不可用（素材库读不回来，或全部被下线）。本地素材和纯色背景不受影响，已经用了在线背景的稿子照常放映。
        </div>
      ) : compact ? (
        <div className="mt-1 grid grid-cols-2 gap-2">{tiles}</div>
      ) : (
        <div className="mt-1 h-[100px] shrink-0">
          <div className="bg-strip-scroll flex gap-2 h-full overflow-x-auto overflow-y-hidden">{tiles}</div>
        </div>
      )}
    </div>
  );
});

/**
 * 只在格子接近可视区时才挂 <img>，滚出去也留着已请求过的那张：
 * 来回滚会反复走网络、格子闪白，在线缩略图只有请求量问题、没有解码内存问题。
 * 高度两种给法：桌面由外面那条 100px 定（h-full），手机端由列宽定（w-full + aspect-video）。
 */
function OnlineTile({
  src,
  title,
  kind,
  onSelect,
  grid = false,
}: {
  src: string;
  title: string;
  kind: 'image' | 'video';
  onSelect: () => void;
  grid?: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const inView = useInView(ref, true);
  const [failed, setFailed] = useState(false);

  return (
    <button
      ref={ref}
      onClick={onSelect}
      title={title}
      className={`aspect-video rounded overflow-hidden border border-white/10 hover:border-blue-500 transition relative bg-black ${
        grid ? 'w-full' : 'h-full shrink-0'
      }`}
    >
      {inView ? (
        <>
          {storedVideoExt(src) ? (
            <video
              src={src}
              className="w-full h-full object-cover"
              muted
              playsInline
              preload="metadata"
              onError={() => setFailed(true)}
            />
          ) : (
            <img
              src={src}
              alt={title}
              className="w-full h-full object-cover"
              decoding="async"
              onError={() => setFailed(true)}
            />
          )}
          {failed && (
            <div className="absolute inset-0 flex items-center justify-center bg-[#0a0a12] text-[10px] text-gray-500">
              无预览
            </div>
          )}
          {kind === 'video' && !failed && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/30">
              <span className="text-lg">▶</span>
            </div>
          )}
        </>
      ) : (
        <div className="w-full h-full flex items-center justify-center text-[10px] text-gray-500">⏳</div>
      )}
    </button>
  );
}
