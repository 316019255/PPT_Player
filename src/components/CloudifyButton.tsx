'use client';

import { useState } from 'react';
import { getMaterial } from '@/lib/localMaterials';
import { uploadMediaToCloud } from '@/lib/mediaClient';

/**
 * 把这一份本机素材搬上云端：字节从这台设备的 IndexedDB 里取，传成功后
 * 这一块的来源换云端路径，于是换电脑放映也看得见。
 *
 * 只做单份，不做「整本一键全搬」：搬不动的本就是这台设备没有的文件，
 * 逐份点反而能看清哪个失败了。
 */
export function CloudifyButton({ localKey, onDone }: { localKey: string; onDone: (path: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const run = async () => {
    setBusy(true);
    setNote('⏳ 正在从本机素材库取出这份文件…');
    try {
      const rec = await getMaterial(localKey);
      if (!rec) {
        setNote('✗ 这台设备的浏览器里没有这份文件，先在「📁 本机 / 素材库」里重新选一次');
        return;
      }
      setNote('⏳ 正在传上云端…');
      const result = await uploadMediaToCloud(rec.blob, rec.kind);
      if (!result.ok) {
        setNote(`✗ ${result.reason}`);
        return;
      }
      onDone(result.path);
      setNote(result.reused ? '☁️ 云端已有同一份，已改为引用它' : '☁️ 已存上云端，换设备也能看到');
    } catch (err) {
      setNote(`✗ ${err instanceof Error ? err.message : '搬运失败'}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1">
      <button
        onClick={() => void run()}
        disabled={busy || !localKey}
        className="w-full h-11 text-xs rounded-lg bg-purple-600/25 hover:bg-purple-600/40 disabled:opacity-50 disabled:cursor-not-allowed text-purple-200 transition"
        title="把这份素材传到你自己的云端空间，传成功后这一页不再依赖本机文件"
      >
        ☁️ 存到云端（换设备也看得到）
      </button>
      {note && <div className="text-[11px] text-gray-400 leading-snug break-words">{note}</div>}
    </div>
  );
}
