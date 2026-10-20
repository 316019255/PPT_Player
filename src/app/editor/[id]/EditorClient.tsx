'use client';

import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { usePptStore } from '@/store/pptStore';
import {
  FREE_PPT_LIMIT,
  FREE_SLIDE_LIMIT,
  createDefaultPresentation,
  createEmptySlide,
  type Background,
  type ImageBlock,
  type MediaSource,
  type Slide,
  type TextBlock,
  type VideoBlock,
} from '@/types/ppt';
import { BackgroundPicker } from '@/components/BackgroundPicker';
import type { LibraryMaterial } from '@/lib/materialLibrary';
import { BlockRenderer } from '@/components/BlockRenderer';
import { CloudifyButton } from '@/components/CloudifyButton';
import { ImageBlockRenderer } from '@/components/ImageBlockRenderer';
import { MediaPicker } from '@/components/MediaPicker';
import { VideoBlockRenderer } from '@/components/VideoBlockRenderer';
import { PhoneDock, SheetShell, type PhoneGroupId } from '@/components/PhoneDock';
import { ImageSheet, PagesSheet, TextSheet, VideoSheet } from '@/components/PhoneSheets';
import { PhoneResizeHandles } from '@/components/PhoneResizeHandles';
import { SlideStage, type StageLayout } from '@/components/SlideStage';
import { SlideThumb } from '@/components/SlideThumb';
import { useCompactEditor } from '@/components/useCompactEditor';
import { useKeyboardInset, useLandscapeViewport } from '@/components/usePhoneViewport';
import { parseLocalKey } from '@/lib/slide-data';
import type { GeometryPatch } from '@/lib/block-geometry';
import { useLocalMaterial } from '@/lib/localMaterials';
import { hasMediaBase } from '@/lib/media-source';
import {
  MAX_RETRIES,
  DRAFT_WRITE_IDLE_MS,
  computeSaveInMs,
  draftIsAhead,
} from '@/lib/autosave';
import { clearDraft, readDraft, writeDraft, NEW_DECK_KEY, type DraftRecord } from '@/lib/draftLog';

interface Props {
  presentationId: number | null;
  initialTitle: string;
  initialData: Slide[] | null;
  initialPro: boolean;
  initialCount: number;
  /** 后台管理的在线素材（materials 表里启用的那些），服务端读 + 缓存 */
  materials: LibraryMaterial[];
}

/** 坞条那一条自身的高度：h-14 加它的 pt-1.5 */
const DOCK_BAND = 62;
/** 编辑窗的下限：窗头 36 + 行选择 36 + 两行输入框 58 + 内边距，少一行就看不到自己打的字 */
const SHEET_FLOOR = 170;
/** 叠层贴底时留的呼吸（pb-2） */
const BOTTOM_PAD = 8;

export default function EditorClient({ presentationId, initialTitle, initialData, initialPro, initialCount, materials }: Props) {
  const router = useRouter();
  const {
    slides, currentSlideIndex, selectedBlockId, title, dirty, past,
    load, setCurrentSlide, setTitle, addSlide, removeSlide, duplicateSlide,
    addTextBlock, duplicateTextBlock, updateTextBlock, removeTextBlock, selectBlock,
    updateImageBlock, removeImageBlock,
    updateVideoBlock, removeVideoBlock,
    markClean, importNotice, clearImportNotice, undo,
  } = usePptStore();

  /** 栈里还有步数就能撤：按钮一直摆在那儿，只是没得撤时按不动 */
  const canUndo = past.length > 0;

  const compact = useCompactEditor();

  /** 桌面：底部那条横栏同时服务三件事，换整页背景 / 往页面里插图 / 插视频 */
  const [insertMode, setInsertMode] = useState<'background' | 'image' | 'video'>('background');

  /** 手机：坞条开着哪一个抽屉，永远只有一个；进场默认展开「页面」（坞条第一个键） */
  const [openGroup, setOpenGroup] = useState<PhoneGroupId | null>('pages');

  /**
   * 图片窗里选图器摊开与否。状态放在外壳，因为那颗开关长在抽屉标题栏的提示语后面。
   * null = 还没手动决定，这时跟着「这一页有没有图块」走：空页进来就摊开，直接能插。
   */
  const [pickingChoice, setPickingChoice] = useState<boolean | null>(null);

  /** 舞台在屏幕上的实际位置和像素尺寸：画布外层那 4 个缩放手柄靠它换算 */
  const [stageLayout, setStageLayout] = useState<StageLayout | null>(null);

  const keyboardInset = useKeyboardInset();
  const landscape = useLandscapeViewport();
  /**
   * 横屏走「画布 + 右侧一栏」，因为横屏时屏幕右边本来就空着，画布又被压扁。
   * 键盘弹出来也不退回竖屏叠式：叠式要给画布留的最低高度在横屏根本放不下（390 高减窗头减坞条就见底了），
   * 以前靠钳位让画布让步，一钳就钳成 0 高、打字时画布直接空白；现在让步的是右栏的高度。
   */
  const rail = landscape;

  const canvasRef = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveMsg, setSaveMsg] = useState('');
  const [retryTick, setRetryTick] = useState(0);
  const [createdId, setCreatedId] = useState<number | null>(null);

  const activeId = createdId ?? presentationId;

  // 导入提示由 dashboard 写入 store，只跟着这次导入的那一份 PPT 展示
  const importWarnings = importNotice && importNotice.id === activeId ? importNotice.warnings : [];

  // 加载：只在真正切换到另一个演示文稿时覆盖本地状态
  const loadedFor = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (loadedFor.current === presentationId) return;
    // 本页刚创建的 PPT：服务端数据是我们自己刚写进去的，保留编辑器里的最新内容
    if (createdId !== null && createdId === presentationId) {
      loadedFor.current = presentationId;
      return;
    }
    loadedFor.current = presentationId;
    const content = initialData?.length
      ? initialData
      : presentationId
        ? [createEmptySlide()]
        : createDefaultPresentation();
    load(content, initialTitle);
  }, [presentationId, createdId, initialData, initialTitle, load]);

  /**
   * 上一次真的发出保存请求的时刻（0 = 没有待存的改动）。
   * 自动保存的空闲上限跟着它算，persist() 每次发请求都会把它推到当下。
   */
  const attemptAt = useRef(0);

  /** 本机日志里躺着一份和线上不一样的草稿，等用户点头才恢复 */
  const [pendingDraft, setPendingDraft] = useState<{ draft: DraftRecord; label: string } | null>(null);

  /** 本机日志的钥匙：还没建档就记在 'new' 上，POST 出真 id 后由 persist 迁走 */
  const draftKey = String(activeId ?? NEW_DECK_KEY);

  // 进来先翻一遍本机日志：崩溃、闪退、直接把标签页划掉丢的那几秒就靠它找回来。
  // 只比内容不比时间戳（线上的 updated_at 前端拿不到，跨设备时钟更不可信），
  // 而且只问不动手 —— 页面加载不弹东西，恢复由这一下点击决定。
  const draftReadFor = useRef<string | null>(null);
  useEffect(() => {
    if (draftReadFor.current === draftKey || createdId !== null) return;
    draftReadFor.current = draftKey;
    const server = {
      title: initialTitle,
      slides: initialData?.length
        ? initialData
        : presentationId
          ? [createEmptySlide()]
          : createDefaultPresentation(),
    };
    void readDraft(draftKey).then((draft) => {
      if (!draft || !draftIsAhead(server, draft)) return;
      const time = new Date(draft.savedAt);
      const hhmm = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
      setPendingDraft({ draft, label: `${draft.slides.length} 页 · 本机 ${hhmm}` });
    });
  }, [draftKey, createdId, initialData, initialTitle, presentationId]);

  // 改了就先落本地：几毫秒、零网络、零函数计费，比上传勤得多 —— 上传那 8 秒空档由它兜住。
  useEffect(() => {
    if (!dirty) return;
    const timer = setTimeout(() => void writeDraft(draftKey, title, slides), DRAFT_WRITE_IDLE_MS);
    return () => clearTimeout(timer);
  }, [dirty, draftKey, title, slides]);

  const currentSlide = slides[currentSlideIndex];
  // 块 id 是 UUID，三个数组里最多命中一个；各查一次即可，不必合成一个列表
  const selectedText = currentSlide?.textBlocks.find((b) => b.id === selectedBlockId) ?? null;
  const selectedImage = currentSlide?.imageBlocks.find((b) => b.id === selectedBlockId) ?? null;
  const selectedVideo = currentSlide?.videoBlocks.find((b) => b.id === selectedBlockId) ?? null;

  /** 这一页还没图块时直接摊开选图器，点进来就能插，不用先按一次「＋ 插一张」 */
  const emptyImagePage = (currentSlide?.imageBlocks.length ?? 0) === 0;
  const picking = pickingChoice ?? emptyImagePage;

  /**
   * 下面这几个回调都写成 useCallback，并且在「调用的那一刻」才去 store 取当前页 ——
   * 内联箭头每次重渲染都是新函数，子组件的 memo 一比 props 就破功，memo 等于白加。
   */
  /** 坞条那颗键：点开一个抽屉，再点已开着的那个就收起；换抽屉时忘掉手动决定 */
  const toggleGroup = useCallback((group: PhoneGroupId) => {
    setPickingChoice(null);
    setOpenGroup((prev) => (prev === group ? null : group));
  }, []);

  /** ✕ 收起当前抽屉 */
  const closeSheet = useCallback(() => {
    setPickingChoice(null);
    setOpenGroup(null);
  }, []);

  /** 加一页并直接进文字窗，省一次点击 */
  const addSlideAndEdit = useCallback(() => {
    addSlide();
    setPickingChoice(null);
    setOpenGroup('text');
  }, [addSlide]);

  const persist = useCallback(
    async (override?: { slides: Slide[]; title: string }): Promise<number | null> => {
      // 恢复本机草稿那条路是「刚 load 进去的内容」要存，闭包里的 slides 还是恢复前的，
      // 所以让调用方把这份直接交进来，不靠下一次渲染才更新的 state。
      const payload = override ?? { slides, title };
      // 强制上限从「上一次尝试」起算，所以发请求的那一刻就要盖章
      attemptAt.current = Date.now();
      setSaving(true);
      setSaveMsg('');
      try {
        const endpoint = activeId ? `/api/presentations/${activeId}` : '/api/presentations';
        const res = await fetch(endpoint, {
          method: activeId ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: payload.title, data: payload.slides }),
        });

        if (res.status === 401) {
          router.replace('/login');
          setSaveError('登录已过期，请重新登录');
          return null;
        }

        const body = (await res.json().catch(() => null)) as { error?: string; id?: number } | null;
        if (!res.ok) throw Object.assign(new Error(body?.error || '保存失败'), { status: res.status });

        markClean();
        setSaveError('');
        setRetryTick(0);

        // 存成功就把这份原样钉回本机日志：内容跟线上一致，下次进编辑器就不会被问「要恢复吗」。
        const savedId = activeId ?? Number(body?.id);
        if (Number.isFinite(savedId)) void writeDraft(String(savedId), payload.title, payload.slides);
        // 'new' 那把钥匙只该活在建档之前：留在本地会让下一份新稿被问「要不要恢复上一份」。
        if (!activeId) void clearDraft(NEW_DECK_KEY);

        if (activeId) {
          setSaveMsg('✓ 已保存');
          return activeId;
        }
        const newId = Number(body?.id);
        setCreatedId(newId);
        router.replace(`/editor/${newId}`);
        return newId;
      } catch (err) {
        const status = (err as { status?: number }).status;
        const reason = err instanceof Error ? err.message : '保存失败';
        // 内容被服务端拒绝（配额/校验）时重试没有意义，交给用户处理
        const permanent = status === 400 || status === 403;
        setSaveError(permanent ? reason : `${reason}（正在重试）`);
        if (!permanent) setRetryTick((n) => n + 1);
        return null;
      } finally {
        setSaving(false);
      }
    },
    [activeId, slides, title, router, markClean]
  );

  /**
   * 自动保存：手停下来 8 秒算一段，落一次；但脏够 30 秒必落一次，
   * 不让人一直打字就一直不存（那样「自动保存」在长稿子上等于没有）。
   * 计时起点是「上一次尝试」，所以一次网络失败既退避、又不至于退到几分钟。
   */
  useEffect(() => {
    if (!dirty) {
      attemptAt.current = 0;
      return;
    }
    if (retryTick > MAX_RETRIES) return;
    if (!attemptAt.current) attemptAt.current = Date.now();
    const timer = setTimeout(() => void persist(), computeSaveInMs({ sinceAttempt: attemptAt.current, retryTick }));
    return () => clearTimeout(timer);
  }, [dirty, slides, title, persist, retryTick]);

  // 切到后台时先把未保存内容写回去；关掉页面前如果还有改动则提示
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState !== 'hidden') return;
      const { dirty: isDirty, slides: current, title: name } = usePptStore.getState();
      if (!isDirty) return;
      // 手机切后台正是「浏览器随手把这个标签页扔掉」的前一刻：本地那一笔不等 400 毫秒，立刻落
      void writeDraft(draftKey, name, current);
      void persist();
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!usePptStore.getState().dirty) return;
      e.preventDefault();
      e.returnValue = '';
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [persist, draftKey]);

  const overQuota = !initialPro && !activeId && initialCount >= FREE_PPT_LIMIT;
  const guardQuota = () => {
    if (overQuota) alert(`免费版最多 ${FREE_PPT_LIMIT} 个演示文稿，请升级 Pro`);
    return overQuota;
  };

  /** 免费/游客：每个 PPT 最多 FREE_SLIDE_LIMIT 页 */
  const slideQuotaHit = !initialPro && slides.length >= FREE_SLIDE_LIMIT;

  const handlePlay = async (slideIdx?: number) => {
    // 没改动又已经落过库：直接用现有 id 放，别再整叠 PUT 一遍（一次放映 = 一份完整 deck 上行
    // + 一趟东京往返 + 一次函数计费，实测最大那份是 174KB）。新建还没存过的稿子必须先存，
    // 否则放映页按 id 找不到内容 —— 没有 activeId 时 persist 走的就是 POST 建档那条路。
    const id = dirty || !activeId ? await persist() : activeId;
    const pid = id ?? activeId;
    if (pid) {
      const slide = (slideIdx ?? currentSlideIndex) + 1; // URL 里是 1-based
      window.open(`/play/${pid}?slide=${slide}`, '_blank');
    }
  };

  /** 恢复本机草稿：先把它摆进编辑器，再原样推上线（推的是这一份，不是闭包里恢复前的旧内容） */
  const restoreDraft = async () => {
    if (!pendingDraft) return;
    const { draft } = pendingDraft;
    setPendingDraft(null);
    load(draft.slides, draft.title);
    await persist({ slides: draft.slides, title: draft.title });
  };

  /** 不要了：连本机日志一起删，下次进来不会再问 */
  const discardDraft = () => {
    if (!pendingDraft) return;
    void clearDraft(pendingDraft.draft.id);
    setPendingDraft(null);
  };

  /** 来源选择器只交出不透明的 src，落在页面哪儿由这里定 */
  const insertImage = useCallback((src: MediaSource, alt?: string) => {
    const st = usePptStore.getState();
    const slide = st.slides[st.currentSlideIndex];
    if (!slide) return;
    // 连续插入时错开一点，免得两张图完全重叠、看起来像只插进去一张
    const step = slide.imageBlocks.length % 4;
    st.addImageBlock(slide.id, { src, x: 20, y: 20 + step * 5, width: 60, height: 60, alt });
  }, []);

  const insertVideo = useCallback((src: MediaSource, alt?: string) => {
    const st = usePptStore.getState();
    const slide = st.slides[st.currentSlideIndex];
    if (!slide) return;
    const step = slide.videoBlocks.length % 4;
    st.addVideoBlock(slide.id, { src, x: 20, y: 20 + step * 5, width: 60, height: 60, alt });
  }, []);

  /** 背景条只服务「正在看的那一页」，所以同样到调用时才取页 */
  const pickBackground = useCallback((bg: Background) => {
    const st = usePptStore.getState();
    const slide = st.slides[st.currentSlideIndex];
    if (slide) st.setBackground(slide.id, bg);
  }, []);

  // 一句话的保存状态：桌面排在标题右侧，手机排在标题下方
  const saveStatus = saveError ? (
    <span className="text-xs text-red-400 truncate" title={saveError}>✗ {saveError}</span>
  ) : dirty ? (
    <span className="text-xs text-yellow-400 shrink-0">● 未保存</span>
  ) : saveMsg ? (
    <span className="text-xs text-green-400 shrink-0">{saveMsg}</span>
  ) : null;

  /** 画布只有一棵树，手机和桌面换的是外壳与控件条，不是舞台 */
  const canvasStage = currentSlide ? (
    <SlideStage
      slide={currentSlide}
      stageRef={canvasRef}
      className="relative w-full h-full"
      onLayout={compact ? setStageLayout : undefined}
      onClick={() => selectBlock(null)}
    >
      {currentSlide.videoBlocks.map((block) => (
        <CanvasVideoBlock key={block.id}
          block={block}
          slideId={currentSlide.id}
          selected={block.id === selectedBlockId}
          containerRef={canvasRef}
          onSelect={selectBlock}
        />
      ))}
      {currentSlide.imageBlocks.map((block) => (
        <CanvasImageBlock key={block.id}
          block={block}
          slideId={currentSlide.id}
          selected={block.id === selectedBlockId}
          containerRef={canvasRef}
          onSelect={selectBlock}
        />
      ))}
      {/* 顺序与 SlideBlocks 保持一致：z-index 相同时文字在上面，编辑器所见才是放映所见 */}
      {currentSlide.textBlocks.map((block) => (
        <CanvasTextBlock key={block.id}
          block={block}
          slideId={currentSlide.id}
          selected={block.id === selectedBlockId}
          containerRef={canvasRef}
          onSelect={selectBlock}
        />
      ))}
    </SlideStage>
  ) : (
    <div className="w-full h-full flex items-center justify-center text-gray-500 text-sm">
      正在加载演示文稿…
    </div>
  );

  /** 屏幕层手柄服务「当前选中的那一个块」，文字/图片/视频块走同一条几何 */
  const selectedBlock = selectedText ?? selectedImage ?? selectedVideo;
  const applyGeometry = useCallback((patch: GeometryPatch) => {
    const st = usePptStore.getState();
    const slide = st.slides[st.currentSlideIndex];
    const id = st.selectedBlockId;
    if (!slide || !id) return;
    // 块 id 是 UUID，三个数组里最多命中一个；判定顺序与 selectedBlock 一致
    if (slide.textBlocks.some((b) => b.id === id)) st.updateTextBlock(slide.id, id, patch);
    else if (slide.imageBlocks.some((b) => b.id === id)) st.updateImageBlock(slide.id, id, patch);
    else if (slide.videoBlocks.some((b) => b.id === id)) st.updateVideoBlock(slide.id, id, patch);
  }, []);

  /** 页面抽屉里的缩略图：只读渲染，别在列表里挂可拖拽的块 */
  const thumb = (slide: Slide) => <SlideThumb slide={slide} className="absolute inset-0 bg-[#1a1a24]" />;

  /** 换背景那一整块：选择器 + 两种「背景为什么只能是纯色」的说明 */
  const backgroundPanel = (slide: Slide) => (
    <>
      <BackgroundPicker online={materials} onSelect={pickBackground} />
      {slide.background.type === 'local' && <LocalBgNotice bg={slide.background} />}
      {slide.background.type === 'cloud' && !hasMediaBase() && <CloudBgNotice bg={slide.background} />}
    </>
  );

  const BACKGROUND_KIND: Record<Background['type'], string> = {
    none: '没背景', color: '纯色', image: '网络图', video: '视频', local: '本机', cloud: '云端',
  };

  const dockCounts: Record<PhoneGroupId, string> = currentSlide
    ? {
        text: `${currentSlide.textBlocks.length} 行`,
        image: `${currentSlide.imageBlocks.length} 张`,
        video: `${currentSlide.videoBlocks.length} 个`,
        background: BACKGROUND_KIND[currentSlide.background.type],
        pages: `${currentSlideIndex + 1}/${slides.length} 页`,
      }
    : { text: '', image: '', video: '', background: '', pages: '' };

  const SHEET_META: Record<PhoneGroupId, { title: string; hint: ReactNode }> = {
    text: { title: '✏️ 文字', hint: '打字即时改，画布同步看' },
    image: {
      title: '🖼️ 图片',
      hint: (
        <>
          插一张或改选中的那张
          <button
            onClick={() => setPickingChoice(!picking)}
            className={`shrink-0 h-7 px-2 rounded-lg text-[10px] transition ${
              picking ? 'bg-white/15 text-white active:bg-white/25' : 'bg-blue-600 text-white active:bg-blue-500'
            }`}
          >
            {picking ? '✕ 收起选图' : '＋ 插一张'}
          </button>
        </>
      ),
    },
    video: { title: '🎬 视频', hint: '插一个或改选中的那个' },
    background: { title: '🎨 背景', hint: `只改第 ${currentSlideIndex + 1} 页` },
    pages: { title: '📄 页面', hint: `共 ${slides.length} 页` },
  };

  const sheetNode =
    currentSlide && openGroup ? (
      <SheetShell
        title={SHEET_META[openGroup].title}
        hint={SHEET_META[openGroup].hint}
        onClose={closeSheet}
      >
        {openGroup === 'text' ? (
          <TextSheet
            slide={currentSlide}
            activeId={selectedText?.id ?? null}
            onPick={selectBlock}
            onAdd={() => addTextBlock(currentSlide.id)}
            onChange={(id, updates) => updateTextBlock(currentSlide.id, id, updates)}
            onDuplicate={(id) => duplicateTextBlock(currentSlide.id, id)}
            onDelete={(id) => removeTextBlock(currentSlide.id, id)}
          />
        ) : openGroup === 'image' ? (
          <ImageSheet
            slide={currentSlide}
            activeId={selectedImage?.id ?? null}
            onPick={selectBlock}
            onChange={(id, updates) => updateImageBlock(currentSlide.id, id, updates)}
            onInsert={insertImage}
            onDelete={(id) => removeImageBlock(currentSlide.id, id)}
            picking={picking}
            onPickingChange={setPickingChoice}
          />
        ) : openGroup === 'video' ? (
          <VideoSheet
            slide={currentSlide}
            activeId={selectedVideo?.id ?? null}
            onPick={selectBlock}
            onChange={(id, updates) => updateVideoBlock(currentSlide.id, id, updates)}
            onInsert={insertVideo}
            onDelete={(id) => removeVideoBlock(currentSlide.id, id)}
          />
        ) : openGroup === 'pages' ? (
          <PagesSheet
            slides={slides}
            currentIndex={currentSlideIndex}
            onPick={setCurrentSlide}
            onAdd={addSlideAndEdit}
            onDuplicate={() => duplicateSlide(currentSlideIndex)}
            onRemove={() => removeSlide(currentSlideIndex)}
            renderThumb={thumb}
            addDisabled={slideQuotaHit}
            duplicateDisabled={slideQuotaHit}
          />
        ) : (
          backgroundPanel(currentSlide)
        )}
      </SheetShell>
    ) : null;

  /** 常驻坞条：四个键一直在，开着的哪一个由 openGroup 决定，永远至多一个 */
  const dock = (
    <PhoneDock
      open={openGroup}
      counts={dockCounts}
      onToggle={toggleGroup}
    />
  );

  /** 抽屉被 ✕ 收起后位置不空着：留一行字说明五个键各管什么 */
  const dockHint = (
    <div className="h-full flex items-center justify-center px-3 text-center text-[11px] leading-snug text-gray-500">
      五个键点开就是全套编辑：页面、文字、图片、视频、背景。
    </div>
  );

  /** 手柄挂在舞台外面：画布缩到 0.28 时，块里那圈手柄只有 2~3 个像素，按不到 */
  const handles =
    compact && currentSlide && stageLayout && selectedBlock ? (
      <PhoneResizeHandles layout={stageLayout} block={selectedBlock} onPatch={applyGeometry} />
    ) : null;

  /** 竖屏那个贴底叠层至少要占多高：开着窗是「坞条 + 窗的下限」，收起后只剩坞条那一条 */
  const stackMin = (sheetNode ? DOCK_BAND + SHEET_FLOOR : DOCK_BAND) + BOTTOM_PAD;

  /**
   * 画布底边在 main 里的位置：竖屏画布是被宽度限制的，宿主 aspect-video 与舞台逐像素重合，底边就等于
   * 9/16 视口宽。优先用舞台自己上报的实测值，首帧还没量到就用等价的 56.25vw 兜底 —— 两者数值相同，
   * 换过来不会跳一下。
   */
  const stageBottom = stageLayout ? `${stageLayout.top + stageLayout.h}px` : '56.25vw';

  return (
    <div className="h-dvh flex flex-col bg-[#0f0f14]">
      {/* 顶部 */}
      <header
        className={`h-14 flex items-center border-b border-white/10 bg-[#14141c] shrink-0 ${
          compact ? 'gap-1.5 px-2' : 'justify-between px-4'
        }`}
      >
        <div className={compact ? 'flex items-center gap-1 min-w-0 flex-1' : 'flex items-center gap-3 min-w-0'}>
          <Link
            href="/dashboard"
            title="返回列表"
            className={`text-gray-400 hover:text-white shrink-0 ${
              compact ? 'w-11 h-11 flex items-center justify-center rounded-lg hover:bg-white/10 text-lg' : 'text-sm'
            }`}
          >
            {compact ? '←' : '← 返回'}
          </Link>
          {compact ? (
            // 手机端标题只读：弹键盘会把画布挤没，改名回电脑端
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium truncate" title={title}>{title}</div>
              <div className="min-h-4 text-xs">{saveStatus}</div>
            </div>
          ) : (
            <>
              <input
                type="text" value={title} onChange={(e) => setTitle(e.target.value)}
                className="bg-transparent border border-transparent hover:border-white/20 focus:border-blue-500 outline-none px-2 py-1 rounded text-base font-medium min-w-[200px]"
              />
              {saveStatus}
            </>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={undo} disabled={!canUndo}
            title={canUndo ? '撤销上一步改动' : '没有可撤销的改动'}
            className={`rounded-lg hover:bg-white/10 transition disabled:opacity-40 disabled:hover:bg-transparent ${
              compact ? 'w-11 h-11 flex items-center justify-center text-base' : 'px-4 py-1.5 text-sm'
            }`}>
            {compact ? '↶' : '↶ 撤销'}
          </button>
          <button
            onClick={() => (dirty ? void persist() : setSaveMsg('✓ 已是最新'))}
            disabled={saving}
            className={`rounded-lg hover:bg-white/10 transition disabled:opacity-50 ${
              compact ? 'w-11 h-11 flex items-center justify-center text-base' : 'px-4 py-1.5 text-sm'
            }`}>
            {compact ? (saving ? '⏳' : '💾') : saving ? '保存中...' : '💾 保存'}
          </button>
          <button onClick={() => handlePlay()}
            className={`rounded-lg bg-blue-600 hover:bg-blue-700 transition ${
              compact ? 'w-11 h-11 flex items-center justify-center text-base' : 'px-4 py-1.5 text-sm'
            }`}>
            {compact ? '▶' : '▶ 播放'}
          </button>
        </div>
      </header>

      {pendingDraft && (
        <div className="px-4 py-2 bg-blue-600/15 border-b border-blue-500/30 text-xs text-blue-200 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="flex-1 min-w-0">
            本机存着一份和线上不一样的草稿（{pendingDraft.label}），通常是上次没来得及保存就退出留下的。
          </span>
          <button
            onClick={() => void restoreDraft()}
            className="shrink-0 rounded bg-blue-600 hover:bg-blue-700 px-3 py-1 text-white transition"
          >
            恢复这份
          </button>
          <button onClick={discardDraft} className="shrink-0 rounded hover:bg-white/10 px-3 py-1 transition">
            丢弃
          </button>
        </div>
      )}

      {importWarnings.length > 0 && (
        <div className="px-4 py-2 bg-yellow-500/10 border-b border-yellow-500/20 text-xs text-yellow-300 flex items-start gap-3">
          <div className="flex-1 space-y-0.5">
            {importWarnings.map((w) => <div key={w}>⚠️ {w}</div>)}
            <div className="text-gray-400">位置继承自母版的文字已按默认间距摆放，请在画布里手动微调。</div>
          </div>
          <button onClick={clearImportNotice} className="text-yellow-200 hover:text-white">知道了</button>
        </div>
      )}

      {/* 手机：画布顶到标题栏下面且永远满尺度，坞条 + 编辑窗是一整块贴底的叠层 */}
      {compact ? (
        rail ? (
          <main className="flex-1 min-h-0 flex overflow-hidden">
            {/* 画布这一栏不跟键盘让步：键盘盖到它下半截，看到的仍是满尺度的画面 */}
            <div className="relative isolate flex-1 min-w-0">
              {canvasStage}
              {handles}
            </div>
            {/* 让的是右栏：键盘那一截从窗下面扣掉，坞条仍压在窗上面 */}
            <div
              className="w-[42%] min-w-[240px] max-w-[320px] shrink-0 flex flex-col border-l border-white/10 bg-[#111119]"
              style={{ paddingBottom: keyboardInset }}
            >
              <div className="h-14 shrink-0 px-1.5 pt-1.5">{dock}</div>
              <div className="flex-1 min-h-0 p-1.5">{sheetNode ?? dockHint}</div>
            </div>
          </main>
        ) : (
          /*
           * 画布不再为编辑窗让高度：宿主按宽度定死 16:9，窗盖住它底边多少算多少。
           * 绝对定位的包含块是 padding box，键盘那一截所以写在叠层的 bottom 上，不能写 main 的
           * paddingBottom —— 那样叠层根本不跟着抬，高度还会把键盘重复算一次。
           */
          <main className="relative flex-1 min-h-0 overflow-hidden">
            <div className="relative isolate z-0 w-full aspect-video">
              {canvasStage}
              {handles}
            </div>
            {/*
             * 高度 = max(min(下限, 键盘以上的空间), 键盘以上的空间 - 画布底边)：
             * 放得下就正好接在画布下面（零重叠），放不下就往上盖住画布底部那一条，
             * 空间连下限都不够时取「键盘以上的空间」封顶在 main 顶边，改由窗里滚动。
             * 一整块不透明、可点击：留透明缝隙会出现「看不见却能按到」的坑，宁可让它实打实地盖住
             * 那一条（贴底块悬在舞台外的 22px 手柄因此按不到，改大小走窗里那两根滑杆）。
             */}
            <div
              className="absolute inset-x-0 z-10 flex flex-col px-2 pb-2 bg-[#0f0f14]"
              style={{
                bottom: keyboardInset,
                height: `max(min(${stackMin}px, calc(100% - ${keyboardInset}px)), calc(100% - ${keyboardInset}px - ${stageBottom}))`,
              }}
            >
              <div className="h-14 shrink-0 pt-1.5">{dock}</div>
              {/* 收起时不再撑一张空卡：叠层照旧接在画布下面（坞条位置一动不动），那段留成页面底色 */}
              {sheetNode && <div className="flex-1 min-h-0 pt-1.5">{sheetNode}</div>}
            </div>
          </main>
        )
      ) : (
        <div className="flex-1 flex overflow-hidden">
        {/* 左：幻灯片列表 */}
        <aside className="w-44 shrink-0 border-r border-white/10 bg-[#111119] flex flex-col">
          <div className="p-2 border-b border-white/10">
            <button onClick={() => !guardQuota() && addSlide()}
              disabled={slideQuotaHit}
              className="w-full py-1.5 text-xs rounded-lg bg-blue-600 hover:bg-blue-700 transition disabled:opacity-30">
              + 添加幻灯片
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-2">
            {slides.map((slide, i) => (
              <div
                key={slide.id}
                onClick={() => setCurrentSlide(i)}
                className={`relative cursor-pointer rounded-lg overflow-hidden border-2 transition group ${
                  i === currentSlideIndex ? 'border-blue-500' : 'border-transparent hover:border-white/20'
                }`}
              >
                <SlideThumb slide={slide} className="w-full aspect-video relative bg-[#1a1a24]" />
                <div className="absolute top-1 left-1 text-[10px] bg-black/60 px-1 rounded">{i + 1}</div>
                <button
                  onClick={(e) => { e.stopPropagation(); handlePlay(i); }}
                  className="absolute top-1 right-1 w-5 h-5 rounded bg-blue-600/90 hover:bg-blue-500 text-[10px] leading-5 opacity-0 group-hover:opacity-100 transition"
                  title="从这页开始播放"
                >▶</button>
              </div>
            ))}
          </div>
        </aside>

        {/* 中：画布 + 底部背景条 */}
        <main className="flex-1 min-w-0 p-4 bg-[#0a0a0f] overflow-hidden flex flex-col gap-3">
          <div className="flex-1 min-h-0">{canvasStage}</div>

          {currentSlide && (
            <section className="shrink-0">
              {/* 模式标签常驻，切的是下面那条横栏的内容；横栏外壳高度两边逐行对齐，所以画面不跳 */}
              <div className="flex gap-1 mb-2">
                {([
                  ['background', '选背景'],
                  ['image', '插图片'],
                  ['video', '插视频'],
                ] as const).map(([mode, label]) => (
                  <button
                    key={mode}
                    onClick={() => setInsertMode(mode)}
                    className={`px-3 py-1 text-xs rounded-lg transition ${
                      insertMode === mode ? 'bg-white/20 text-white' : 'bg-white/5 text-gray-400 hover:text-white'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {insertMode === 'background' ? backgroundPanel(currentSlide)
                : insertMode === 'image' ? <MediaPicker kind="image" onInsert={insertImage} />
                : <MediaPicker kind="video" onInsert={insertVideo} />}
            </section>
          )}
        </main>

        {/* 右：属性面板 */}
        <aside className="w-72 shrink-0 border-l border-white/10 bg-[#111119] flex flex-col overflow-y-auto">
          <div className="p-4 space-y-6">
            <div>
              <h3 className="text-xs font-semibold text-gray-400 mb-2">
                幻灯片 {currentSlideIndex + 1} / {slides.length}
              </h3>
              <div className="grid grid-cols-2 gap-1.5">
                <button onClick={() => duplicateSlide(currentSlideIndex)} disabled={!currentSlide || slideQuotaHit}
                  className="py-1.5 text-xs rounded bg-white/5 hover:bg-white/10 transition disabled:opacity-30">复制本页</button>
                <button onClick={() => removeSlide(currentSlideIndex)} disabled={slides.length <= 1}
                  className="py-1.5 text-xs rounded bg-white/5 hover:bg-white/10 transition disabled:opacity-30">删除本页</button>
                <button onClick={() => currentSlide && !guardQuota() && addTextBlock(currentSlide.id)} disabled={!currentSlide}
                  className="py-1.5 text-xs rounded bg-blue-600/80 hover:bg-blue-600 transition disabled:opacity-30">+ 文字</button>
                <button onClick={() => setInsertMode('image')} disabled={!currentSlide}
                  title="切到画布下方的图片来源条：本机文件、本地素材库或网络地址都能选"
                  className="py-1.5 text-xs rounded bg-blue-600/80 hover:bg-blue-600 transition disabled:opacity-30">+ 图片</button>
                <button onClick={() => setInsertMode('video')} disabled={!currentSlide}
                  title="切到画布下方的视频来源条"
                  className="py-1.5 text-xs rounded bg-blue-600/80 hover:bg-blue-600 transition disabled:opacity-30">+ 视频</button>
              </div>
            </div>

            {selectedText && currentSlide ? (
              <BlockPropsPanel
                block={selectedText}
                onChange={(updates) => updateTextBlock(currentSlide.id, selectedText.id, updates)}
                onDelete={() => removeTextBlock(currentSlide.id, selectedText.id)}
              />
            ) : selectedImage && currentSlide ? (
              <ImagePropsPanel
                block={selectedImage}
                onChange={(updates) => updateImageBlock(currentSlide.id, selectedImage.id, updates)}
                onDelete={() => removeImageBlock(currentSlide.id, selectedImage.id)}
              />
            ) : selectedVideo && currentSlide ? (
              <VideoPropsPanel
                block={selectedVideo}
                onChange={(updates) => updateVideoBlock(currentSlide.id, selectedVideo.id, updates)}
                onDelete={() => removeVideoBlock(currentSlide.id, selectedVideo.id)}
              />
            ) : (
              <div className="text-center text-gray-500 text-xs py-4">
                点击画布中的文字、图片或视频进行编辑<br />
                <span className="text-gray-600">拖动移动 · 8 个手柄缩放 · Delete 删除</span>
              </div>
            )}
          </div>
        </aside>
        </div>
      )}
    </div>
  );
}

// ============ 画布里的单个块 ============
/**
 * 这三个包装组件只为一件事：把「改哪一页的哪一块」绑成身份恒定的回调。
 * 内联箭头传下去的话，父级每敲一个字都重建一次函数，块渲染器永远跳不过重渲染；
 * 绑成 useCallback 之后，没被改动的那个块的 props 按身份全等，memo 才真能挡下来。
 */
interface CanvasBlockProps<B> {
  block: B;
  slideId: string;
  selected: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onSelect: (id: string) => void;
}

const CanvasTextBlock = memo(function CanvasTextBlock({
  block, slideId, selected, containerRef, onSelect,
}: CanvasBlockProps<TextBlock>) {
  const onUpdate = useCallback(
    (updates: Partial<TextBlock>) => usePptStore.getState().updateTextBlock(slideId, block.id, updates),
    [slideId, block.id]
  );
  const onDelete = useCallback(
    () => usePptStore.getState().removeTextBlock(slideId, block.id),
    [slideId, block.id]
  );
  return (
    <BlockRenderer block={block} selected={selected} containerRef={containerRef}
      onSelect={onSelect} onUpdate={onUpdate} onDelete={onDelete} />
  );
});

const CanvasImageBlock = memo(function CanvasImageBlock({
  block, slideId, selected, containerRef, onSelect,
}: CanvasBlockProps<ImageBlock>) {
  const onUpdate = useCallback(
    (updates: Partial<ImageBlock>) => usePptStore.getState().updateImageBlock(slideId, block.id, updates),
    [slideId, block.id]
  );
  const onDelete = useCallback(
    () => usePptStore.getState().removeImageBlock(slideId, block.id),
    [slideId, block.id]
  );
  return (
    <ImageBlockRenderer block={block} selected={selected} containerRef={containerRef}
      onSelect={onSelect} onUpdate={onUpdate} onDelete={onDelete} />
  );
});

const CanvasVideoBlock = memo(function CanvasVideoBlock({
  block, slideId, selected, containerRef, onSelect,
}: CanvasBlockProps<VideoBlock>) {
  const onUpdate = useCallback(
    (updates: Partial<VideoBlock>) => usePptStore.getState().updateVideoBlock(slideId, block.id, updates),
    [slideId, block.id]
  );
  const onDelete = useCallback(
    () => usePptStore.getState().removeVideoBlock(slideId, block.id),
    [slideId, block.id]
  );
  return (
    <VideoBlockRenderer block={block} selected={selected} containerRef={containerRef}
      onSelect={onSelect} onUpdate={onUpdate} onDelete={onDelete} />
  );
});

// ============ 文字块属性面板 ============
function BlockPropsPanel({
  block, onChange, onDelete,
}: {
  block: TextBlock;
  onChange: (updates: Partial<TextBlock>) => void;
  onDelete: () => void;
}) {
  const height = block.height ?? 12;

  return (
    <div>
      <h3 className="text-xs font-semibold text-gray-400 mb-2">文字属性</h3>
      <div className="space-y-3">
        {/* 字号 */}
        <div>
          <label className="text-[11px] text-gray-500 block mb-1">字号: {block.fontSize}px</label>
          <input type="range" min={10} max={144} value={block.fontSize}
            onChange={(e) => onChange({ fontSize: Number(e.target.value) })}
            className="w-full accent-blue-500" />
        </div>

        {/* 颜色 */}
        <div className="flex items-center gap-2">
          <label className="text-[11px] text-gray-500 w-10">颜色</label>
          <input type="color" value={block.color}
            onChange={(e) => onChange({ color: e.target.value })}
            className="w-8 h-7 rounded cursor-pointer bg-transparent border border-white/10" />
          <span className="text-[10px] text-gray-500">{block.color}</span>
        </div>

        {/* 粗体/斜体 */}
        <div className="flex gap-1">
          <button onClick={() => onChange({ fontWeight: block.fontWeight === 'bold' ? 'normal' : 'bold' })}
            className={`px-3 py-1 rounded text-sm font-bold transition ${
              block.fontWeight === 'bold' ? 'bg-blue-600' : 'bg-white/10 hover:bg-white/20'}`}>B</button>
          <button onClick={() => onChange({ fontStyle: block.fontStyle === 'italic' ? 'normal' : 'italic' })}
            className={`px-3 py-1 rounded text-sm italic transition ${
              block.fontStyle === 'italic' ? 'bg-blue-600' : 'bg-white/10 hover:bg-white/20'}`}>I</button>
          <button onClick={() => onChange({ fontSize: Math.max(10, block.fontSize - 2) })}
            className="px-2 py-1 rounded text-xs bg-white/10 hover:bg-white/20">A-</button>
          <button onClick={() => onChange({ fontSize: Math.min(144, block.fontSize + 2) })}
            className="px-2 py-1 rounded text-xs bg-white/10 hover:bg-white/20">A+</button>
        </div>

        {/* 对齐 */}
        <div className="flex gap-1">
          {(['left', 'center', 'right'] as const).map((align) => (
            <button key={align} onClick={() => onChange({ textAlign: align })}
              className={`flex-1 py-1 rounded text-[11px] transition ${
                block.textAlign === align ? 'bg-blue-600' : 'bg-white/10 hover:bg-white/20'}`}>
              {align === 'left' ? '左' : align === 'center' ? '中' : '右'}
            </button>
          ))}
        </div>

        {/* 文字不透明度：下限 10%，不给 0（整块看不见会让人以为字丢了） */}
        <div>
          <label className="text-[11px] text-gray-500 block">
            文字不透明度: {Math.round((block.opacity ?? 1) * 100)}%
          </label>
          <input type="range" min={10} max={100} value={Math.round((block.opacity ?? 1) * 100)}
            onChange={(e) => onChange({ opacity: Number(e.target.value) / 100 })}
            className="w-full accent-blue-500" />
        </div>

        <hr className="border-white/10" />

        {/* 位置 */}
        <GeomSliders geom={{ x: block.x, y: block.y, width: block.width, height }} onChange={onChange} />

        <hr className="border-white/10" />

        {/* 文本框外观 */}
        <div>
          <div className="text-[11px] font-semibold text-gray-400 mb-2">文本框外观</div>

          <div className="flex items-center gap-2 mb-2">
            <label className="text-[11px] text-gray-500 w-12">背景</label>
            <input type="color" value={block.bgColor || '#000000'}
              onChange={(e) => onChange({ bgColor: e.target.value })}
              className="w-8 h-7 rounded cursor-pointer bg-transparent border border-white/10" />
            <button onClick={() => onChange({ bgColor: '' })}
              className="text-[10px] text-gray-500 hover:text-white">清除</button>
          </div>

          {block.bgColor && (
            <div className="mb-2">
              <label className="text-[11px] text-gray-500 block">
                背景透明度: {Math.round((block.bgOpacity ?? 1) * 100)}%
              </label>
              <input type="range" min={0} max={100} value={(block.bgOpacity ?? 1) * 100}
                onChange={(e) => onChange({ bgOpacity: Number(e.target.value) / 100 })}
                className="w-full accent-blue-500" />
            </div>
          )}

          <div className="mb-2">
            <label className="text-[11px] text-gray-500 block">圆角: {block.borderRadius ?? 0}px</label>
            <input type="range" min={0} max={30} value={block.borderRadius ?? 0}
              onChange={(e) => onChange({ borderRadius: Number(e.target.value) })}
              className="w-full accent-blue-500" />
          </div>

          <div className="mb-2">
            <label className="text-[11px] text-gray-500 block">内边距: {block.padding ?? 4}px</label>
            <input type="range" min={0} max={30} value={block.padding ?? 4}
              onChange={(e) => onChange({ padding: Number(e.target.value) })}
              className="w-full accent-blue-500" />
          </div>

          <div className="flex items-center gap-2 mb-2">
            <label className="text-[11px] text-gray-500 w-12">边框</label>
            <input type="color" value={block.borderColor || '#ffffff'}
              onChange={(e) => onChange({ borderColor: e.target.value })}
              className="w-8 h-7 rounded cursor-pointer bg-transparent border border-white/10" />
            <button onClick={() => onChange({ borderColor: '', borderWidth: 0 })}
              className="text-[10px] text-gray-500 hover:text-white">清除</button>
          </div>
          {block.borderColor && (
            <div className="mb-2">
              <label className="text-[11px] text-gray-500 block">边框宽度: {block.borderWidth ?? 0}px</label>
              <input type="range" min={0} max={10} value={block.borderWidth ?? 0}
                onChange={(e) => onChange({ borderWidth: Number(e.target.value) })}
                className="w-full accent-blue-500" />
            </div>
          )}

          <div className="flex items-center gap-2">
            <button onClick={() => onChange({ zIndex: (block.zIndex ?? 1) - 1 })}
              className="flex-1 py-1 text-[11px] rounded bg-white/10 hover:bg-white/20">↓ 下移一层</button>
            <button onClick={() => onChange({ zIndex: (block.zIndex ?? 1) + 1 })}
              className="flex-1 py-1 text-[11px] rounded bg-white/10 hover:bg-white/20">↑ 上移一层</button>
          </div>
        </div>

        <button onClick={onDelete}
          className="w-full py-2 text-sm rounded-lg bg-red-600/20 hover:bg-red-600/40 text-red-300 transition">
          🗑️ 删除文字块
        </button>
      </div>
    </div>
  );
}

// ============ 几何滑杆（文字块与图片块共用） ============
interface Geometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

function GeomSliders({
  geom, onChange,
}: {
  geom: Geometry;
  onChange: (updates: Partial<Geometry>) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 text-[11px]">
      <div>
        <label className="text-gray-500 block">X: {geom.x.toFixed(0)}%</label>
        <input type="range" min={0} max={100} value={geom.x}
          onChange={(e) => onChange({ x: Number(e.target.value) })}
          className="w-full accent-blue-500" />
      </div>
      <div>
        <label className="text-gray-500 block">Y: {geom.y.toFixed(0)}%</label>
        <input type="range" min={0} max={100} value={geom.y}
          onChange={(e) => onChange({ y: Number(e.target.value) })}
          className="w-full accent-blue-500" />
      </div>
      <div>
        <label className="text-gray-500 block">宽: {geom.width.toFixed(0)}%</label>
        <input type="range" min={3} max={100} value={geom.width}
          onChange={(e) => onChange({ width: Number(e.target.value) })}
          className="w-full accent-blue-500" />
      </div>
      <div>
        <label className="text-gray-500 block">高: {geom.height.toFixed(0)}%</label>
        <input type="range" min={2} max={100} value={geom.height}
          onChange={(e) => onChange({ height: Number(e.target.value) })}
          className="w-full accent-blue-500" />
      </div>
    </div>
  );
}

// ============ 图片块属性面板 ============
const FIT_OPTIONS: { value: NonNullable<ImageBlock['fit']>; label: string; hint: string }[] = [
  { value: 'contain', label: '适应', hint: '完整显示，可能留白' },
  { value: 'cover', label: '填满', hint: '铺满框，超出裁掉' },
  { value: 'fill', label: '拉伸', hint: '硬拉到框尺寸，可能变形' },
];

function sourceLabel(src: ImageBlock['src']): string {
  if (src.kind === 'local') return '📁 本机';
  if (src.kind === 'cloud') return '☁️ 云端';
  return '🔗 网络';
}

function ImagePropsPanel({
  block, onChange, onDelete,
}: {
  block: ImageBlock;
  onChange: (updates: Partial<ImageBlock>) => void;
  onDelete: () => void;
}) {
  return (
    <div>
      <h3 className="text-xs font-semibold text-gray-400 mb-2">图片属性</h3>
      <div className="space-y-3">
        <div className="text-[11px] text-gray-500 flex items-center gap-2 min-w-0">
          <span className="shrink-0">{sourceLabel(block.src)}</span>
          <span className="truncate" title={block.alt ?? block.src.value}>
            {block.alt || block.src.value}
          </span>
        </div>

        {/* 显示方式：三种 object-fit 的中文说法，鼠标停在上面解释差别 */}
        <div>
          <label className="text-[11px] text-gray-500 block mb-1">显示方式</label>
          <div className="flex gap-1">
            {FIT_OPTIONS.map((opt) => (
              <button key={opt.value} onClick={() => onChange({ fit: opt.value })} title={opt.hint}
                className={`flex-1 py-1 rounded text-[11px] transition ${
                  (block.fit ?? 'contain') === opt.value ? 'bg-blue-600' : 'bg-white/10 hover:bg-white/20'}`}>
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <hr className="border-white/10" />

        <GeomSliders geom={{ x: block.x, y: block.y, width: block.width, height: block.height }} onChange={onChange} />

        <hr className="border-white/10" />

        <div className="flex items-center gap-2">
          <button onClick={() => onChange({ zIndex: Math.max(1, (block.zIndex ?? 1) - 1) })}
            className="flex-1 py-1 text-[11px] rounded bg-white/10 hover:bg-white/20">↓ 压到文字下</button>
          <button onClick={() => onChange({ zIndex: Math.min(999, (block.zIndex ?? 1) + 1) })}
            className="flex-1 py-1 text-[11px] rounded bg-white/10 hover:bg-white/20">↑ 盖住文字</button>
        </div>

        {block.src.kind === 'local' && hasMediaBase() && (
          <CloudifyButton
            localKey={parseLocalKey(block.src.value)}
            onDone={(path) => onChange({ src: { kind: 'cloud', value: path } })}
          />
        )}

        <button onClick={onDelete}
          className="w-full py-2 text-sm rounded-lg bg-red-600/20 hover:bg-red-600/40 text-red-300 transition">
          🗑️ 删除图片
        </button>
      </div>
    </div>
  );
}

// ============ 视频块属性面板 ============
function VideoPropsPanel({
  block, onChange, onDelete,
}: {
  block: VideoBlock;
  onChange: (updates: Partial<VideoBlock>) => void;
  onDelete: () => void;
}) {
  return (
    <div>
      <h3 className="text-xs font-semibold text-gray-400 mb-2">视频属性</h3>
      <div className="space-y-3">
        <div className="text-[11px] text-gray-500 flex items-center gap-2 min-w-0">
          <span className="shrink-0">{sourceLabel(block.src)}</span>
          <span className="truncate" title={block.alt ?? block.src.value}>
            {block.alt || block.src.value}
          </span>
        </div>

        {/* 显示方式 */}
        <div>
          <label className="text-[11px] text-gray-500 block mb-1">显示方式</label>
          <div className="flex gap-1">
            {FIT_OPTIONS.map((opt) => (
              <button key={opt.value} onClick={() => onChange({ fit: opt.value })} title={opt.hint}
                className={`flex-1 py-1 rounded text-[11px] transition ${
                  (block.fit ?? 'contain') === opt.value ? 'bg-blue-600' : 'bg-white/10 hover:bg-white/20'}`}>
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* 播放选项 */}
        <div>
          <label className="text-[11px] text-gray-500 block mb-1">播放选项</label>
          <div className="flex gap-1 flex-wrap">
            <button onClick={() => onChange({ loop: !(block.loop ?? false) })}
              className={`flex-1 py-1 rounded text-[11px] transition ${block.loop ? 'bg-blue-600' : 'bg-white/10 hover:bg-white/20'}`}>
              🔁 循环
            </button>
            <button onClick={() => onChange({ muted: block.muted === false })}
              className={`flex-1 py-1 rounded text-[11px] transition ${block.muted !== false ? 'bg-blue-600' : 'bg-white/10 hover:bg-white/20'}`}>
              🔇 静音
            </button>
            <button onClick={() => onChange({ controls: !(block.controls ?? false) })}
              className={`flex-1 py-1 rounded text-[11px] transition ${block.controls ? 'bg-blue-600' : 'bg-white/10 hover:bg-white/20'}`}>
              🎛️ 控件
            </button>
          </div>
        </div>

        <hr className="border-white/10" />

        <GeomSliders geom={{ x: block.x, y: block.y, width: block.width, height: block.height }} onChange={onChange} />

        <hr className="border-white/10" />

        <div className="flex items-center gap-2">
          <button onClick={() => onChange({ zIndex: Math.max(1, (block.zIndex ?? 1) - 1) })}
            className="flex-1 py-1 text-[11px] rounded bg-white/10 hover:bg-white/20">↓ 压到文字下</button>
          <button onClick={() => onChange({ zIndex: Math.min(999, (block.zIndex ?? 1) + 1) })}
            className="flex-1 py-1 text-[11px] rounded bg-white/10 hover:bg-white/20">↑ 盖住文字</button>
        </div>

        {block.src.kind === 'local' && hasMediaBase() && (
          <CloudifyButton
            localKey={parseLocalKey(block.src.value)}
            onDone={(path) => onChange({ src: { kind: 'cloud', value: path } })}
          />
        )}

        <button onClick={onDelete}
          className="w-full py-2 text-sm rounded-lg bg-red-600/20 hover:bg-red-600/40 text-red-300 transition">
          🗑️ 删除视频
        </button>
      </div>
    </div>
  );
}

// ============ 本地素材缺失提示 ============
function LocalBgNotice({ bg }: { bg: Background }) {
  const mat = useLocalMaterial(parseLocalKey(bg.value));
  if (mat.status === 'pending' || mat.status === 'ready') return null;
  const fileName = bg.name ? `「${bg.name}」` : '';
  return (
    <div className="mt-2 text-[11px] text-yellow-400 bg-yellow-500/10 rounded p-2 leading-snug">
      {mat.status === 'missing' ? (
        <>本机浏览器里没有这个素材{fileName}，背景暂显示为纯色。在上方「📁 本地」里重新选一次即可恢复。</>
      ) : (
        <>本地素材读取失败{mat.status === 'error' ? `：${mat.reason}` : ''}，背景暂显示为纯色。</>
      )}
    </div>
  );
}

/** 背景在云端桶里，而本站没配公开读地址：画面只能是纯色，得说清楚不是图丢了 */
function CloudBgNotice({ bg }: { bg: Background }) {
  return (
    <div className="mt-2 text-[11px] text-yellow-400 bg-yellow-500/10 rounded p-2 leading-snug">
      云端背景{bg.name ? `「${bg.name}」` : ''}还在，只是本站还没配云端公开读地址
      （NEXT_PUBLIC_MEDIA_PUBLIC_BASE），所以现在显示纯色。配好后回来就是这张图。
    </div>
  );
}
