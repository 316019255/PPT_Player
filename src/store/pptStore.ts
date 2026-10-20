import { create } from 'zustand';
import { ImageBlock, ImageSource, Slide, TextBlock, VideoBlock, VideoSource, createEmptySlide } from '@/types/ppt';
import { DEFAULT_BLOCK_HEIGHT, STAGE_MAX, clamp } from '@/lib/block-geometry';
import { editGroup, pushHistory, sealTop, takeLast, type HistoryEntry } from '@/lib/history';

interface ImportNotice {
  id: number;
  warnings: string[];
}

/** 撤销要还原的就这几样：内容 + 正看着哪一页、选着哪一块 */
interface EditSnapshot {
  slides: Slide[];
  title: string;
  currentSlideIndex: number;
  selectedBlockId: string | null;
}

interface PptState {
  slides: Slide[];
  currentSlideIndex: number;
  selectedBlockId: string | null;
  title: string;
  dirty: boolean;
  importNotice: ImportNotice | null;
  /** 撤销栈，栈顶是「最近那一步改动之前」的样子；长度为 0 就没得撤 */
  past: HistoryEntry<EditSnapshot>[];

  setImportNotice: (notice: ImportNotice) => void;
  clearImportNotice: () => void;

  load: (slides: Slide[], title: string) => void;
  undo: () => void;
  addSlide: () => void;
  removeSlide: (index: number) => void;
  duplicateSlide: (index: number) => void;
  moveSlide: (from: number, to: number) => void;
  setCurrentSlide: (index: number) => void;
  setTitle: (title: string) => void;
  markClean: () => void;

  setBackground: (slideId: string, background: Slide['background']) => void;

  addTextBlock: (slideId: string) => void;
  duplicateTextBlock: (slideId: string, blockId: string) => void;
  updateTextBlock: (slideId: string, blockId: string, updates: Partial<TextBlock>) => void;
  removeTextBlock: (slideId: string, blockId: string) => void;
  selectBlock: (blockId: string | null) => void;

  addImageBlock: (
    slideId: string,
    input: { src: ImageSource; x: number; y: number; width: number; height: number; alt?: string; fit?: ImageBlock['fit'] }
  ) => void;
  updateImageBlock: (slideId: string, blockId: string, updates: Partial<ImageBlock>) => void;
  removeImageBlock: (slideId: string, blockId: string) => void;
  /** 本地图转存到云端时换来源，块 id 不动，选中态和拖拽手感才不会断 */
  replaceImageBlockSrc: (slideId: string, blockId: string, src: ImageSource) => void;

  addVideoBlock: (
    slideId: string,
    input: { src: VideoSource; x: number; y: number; width: number; height: number; alt?: string; fit?: VideoBlock['fit'] }
  ) => void;
  updateVideoBlock: (slideId: string, blockId: string, updates: Partial<VideoBlock>) => void;
  removeVideoBlock: (slideId: string, blockId: string) => void;
  replaceVideoBlockSrc: (slideId: string, blockId: string, src: VideoSource) => void;
}

/** 文字块、图片块、视频块是同一层缩放舞台里的兄弟节点，层级按页内元素总数递增才压得住 */
const nextZIndex = (slide: Slide) => slide.textBlocks.length + slide.imageBlocks.length + slide.videoBlocks.length + 1;

const snapshotOf = (state: PptState): EditSnapshot => ({
  slides: state.slides,
  title: state.title,
  currentSlideIndex: state.currentSlideIndex,
  selectedBlockId: state.selectedBlockId,
});

export const usePptStore = create<PptState>((set, get) => {
  /**
   * 内容要变了：先把「改之前」压进撤销栈，再落这次改动。
   * 传了 group 才可能并进上一步（打字、拖角、拖滑杆靠它合成一步），不传就是独立一步。
   */
  const apply = (
    patch: Partial<PptState> | ((state: PptState) => Partial<PptState>),
    group: string | null = null
  ) =>
    set((state) => {
      const next = typeof patch === 'function' ? patch(state) : patch;
      // 动作自己判定「什么都不用改」（比如只剩一页还要删）时别留一步假的
      if (next === state) return state;
      return { ...next, past: pushHistory(state.past, snapshotOf(state), group, Date.now()) };
    });

  return {
    slides: [],
    currentSlideIndex: 0,
    selectedBlockId: null,
    title: '',
    dirty: false,
    importNotice: null,
    past: [],

    setImportNotice: (notice) => set({ importNotice: notice }),
    clearImportNotice: () => set({ importNotice: null }),

    // 换一份内容进来（首次加载、切 deck）：历史到此为止，不然能撤出上一份 PPT 的页
    load: (slides, title) =>
      set({ slides, title, currentSlideIndex: 0, selectedBlockId: null, dirty: false, past: [] }),

    undo: () => {
      const taken = takeLast(get().past);
      if (!taken) return;
      // 撤销本身不该再记一步，所以走裸 set；栈顶封口，撤完接着改算新的一串
      set({ ...taken.entry.state, past: sealTop(taken.past), dirty: true });
    },

    addSlide: () => {
      const newSlide = createEmptySlide();
      apply((state) => ({
        slides: [...state.slides, newSlide],
        currentSlideIndex: state.slides.length,
        selectedBlockId: null,
        dirty: true,
      }));
    },

    removeSlide: (index) => {
      apply((state) => {
        if (state.slides.length <= 1) return state;
        const newSlides = state.slides.filter((_, i) => i !== index);
        return {
          slides: newSlides,
          currentSlideIndex: Math.min(state.currentSlideIndex, newSlides.length - 1),
          selectedBlockId: null,
          dirty: true,
        };
      });
    },

    duplicateSlide: (index) => {
      apply((state) => {
        const original = state.slides[index];
        if (!original) return state;
        const copy: Slide = {
          ...original,
          id: crypto.randomUUID(),
          textBlocks: original.textBlocks.map((b) => ({ ...b, id: crypto.randomUUID() })),
          // 图片块只换 id，src 原样留着：同一张图不该被复制成两份素材
          imageBlocks: original.imageBlocks.map((b) => ({ ...b, id: crypto.randomUUID() })),
          videoBlocks: original.videoBlocks.map((b) => ({ ...b, id: crypto.randomUUID() })),
        };
        const newSlides = [...state.slides];
        newSlides.splice(index + 1, 0, copy);
        return {
          slides: newSlides,
          currentSlideIndex: index + 1,
          selectedBlockId: null,
          dirty: true,
        };
      });
    },

    moveSlide: (from, to) => {
      apply((state) => {
        if (from === to) return state;
        const newSlides = [...state.slides];
        const [item] = newSlides.splice(from, 1);
        newSlides.splice(to, 0, item);
        return { slides: newSlides, currentSlideIndex: to, dirty: true };
      });
    },

    setCurrentSlide: (index) =>
      set((state) => ({
        currentSlideIndex: Math.max(0, Math.min(index, state.slides.length - 1)),
        selectedBlockId: null,
      })),

    // 改名是一个字一个字敲的，并进步；和块的打字一样只认「同一段时间内的连续改动」
    setTitle: (title) => apply({ title, dirty: true }, 'title'),
    markClean: () => set({ dirty: false }),

    setBackground: (slideId, background) => {
      apply((state) => ({
        slides: state.slides.map((s) => (s.id === slideId ? { ...s, background } : s)),
        dirty: true,
      }));
    },

    addTextBlock: (slideId) => {
      apply((state) => {
        const slide = state.slides.find((s) => s.id === slideId);
        if (!slide) return state;
        const block: TextBlock = {
          id: crypto.randomUUID(),
          text: '点击编辑文字',
          x: 15,
          // 一屏歌词条时别把新行掉到舞台外面（框高 10）
          y: clamp(45 + slide.textBlocks.length * 10, 0, STAGE_MAX - 10),
          width: 70,
          height: 10,
          fontSize: 28,
          color: '#ffffff',
          fontWeight: 'normal' as const,
          fontStyle: 'normal' as const,
          textAlign: 'center' as const,
          bgColor: '',
          bgOpacity: 1,
          borderRadius: 0,
          padding: 6,
          borderColor: '',
          borderWidth: 0,
          zIndex: nextZIndex(slide),
        };
        return {
          slides: state.slides.map((s) =>
            s.id === slideId ? { ...s, textBlocks: [...s.textBlocks, block] } : s
          ),
          // 和图片块一样：新建即选中，手机端抽屉才知道要编辑哪一块
          selectedBlockId: block.id,
          dirty: true,
        };
      });
    },

    duplicateTextBlock: (slideId, blockId) => {
      apply((state) => {
        const slide = state.slides.find((s) => s.id === slideId);
        const source = slide?.textBlocks.find((b) => b.id === blockId);
        if (!slide || !source) return state;
        const copy: TextBlock = {
          ...source,
          id: crypto.randomUUID(),
          y: clamp(source.y + 4, 0, STAGE_MAX - (source.height ?? DEFAULT_BLOCK_HEIGHT)),
          zIndex: nextZIndex(slide),
        };
        // 紧跟在原行后面插：副歌复制出来就该在它该在的位置上
        const textBlocks = [...slide.textBlocks];
        textBlocks.splice(textBlocks.indexOf(source) + 1, 0, copy);
        return {
          slides: state.slides.map((s) => (s.id === slideId ? { ...s, textBlocks } : s)),
          selectedBlockId: copy.id,
          dirty: true,
        };
      });
    },

    updateTextBlock: (slideId, blockId, updates) => {
      apply(
        (state) => ({
          slides: state.slides.map((s) =>
            s.id === slideId
              ? {
                  ...s,
                  textBlocks: s.textBlocks.map((b) => (b.id === blockId ? { ...b, ...updates } : b)),
                }
              : s
          ),
          dirty: true,
        }),
        editGroup(Object.keys(updates), slideId, blockId)
      );
    },

    removeTextBlock: (slideId, blockId) => {
      apply((state) => ({
        slides: state.slides.map((s) =>
          s.id === slideId
            ? { ...s, textBlocks: s.textBlocks.filter((b) => b.id !== blockId) }
            : s
        ),
        selectedBlockId: null,
        dirty: true,
      }));
    },

    addImageBlock: (slideId, input) => {
      apply((state) => {
        const slide = state.slides.find((s) => s.id === slideId);
        if (!slide) return state;
        const block: ImageBlock = {
          id: crypto.randomUUID(),
          src: input.src,
          x: input.x,
          y: input.y,
          width: input.width,
          height: input.height,
          ...(input.alt ? { alt: input.alt } : {}),
          ...(input.fit ? { fit: input.fit } : {}),
          zIndex: nextZIndex(slide),
        };
        return {
          slides: state.slides.map((s) =>
            s.id === slideId ? { ...s, imageBlocks: [...s.imageBlocks, block] } : s
          ),
          selectedBlockId: block.id,
          dirty: true,
        };
      });
    },

    updateImageBlock: (slideId, blockId, updates) => {
      apply(
        (state) => ({
          slides: state.slides.map((s) =>
            s.id === slideId
              ? {
                  ...s,
                  imageBlocks: s.imageBlocks.map((b) => (b.id === blockId ? { ...b, ...updates } : b)),
                }
              : s
          ),
          dirty: true,
        }),
        editGroup(Object.keys(updates), slideId, blockId)
      );
    },

    removeImageBlock: (slideId, blockId) => {
      apply((state) => ({
        slides: state.slides.map((s) =>
          s.id === slideId
            ? { ...s, imageBlocks: s.imageBlocks.filter((b) => b.id !== blockId) }
            : s
        ),
        selectedBlockId: null,
        dirty: true,
      }));
    },

    replaceImageBlockSrc: (slideId, blockId, src) => {
      apply((state) => ({
        slides: state.slides.map((s) =>
          s.id === slideId
            ? { ...s, imageBlocks: s.imageBlocks.map((b) => (b.id === blockId ? { ...b, src } : b)) }
            : s
        ),
        dirty: true,
      }));
    },

    addVideoBlock: (slideId, input) => {
      apply((state) => {
        const slide = state.slides.find((s) => s.id === slideId);
        if (!slide) return state;
        const block: VideoBlock = {
          id: crypto.randomUUID(),
          src: input.src,
          x: input.x,
          y: input.y,
          width: input.width,
          height: input.height,
          ...(input.alt ? { alt: input.alt } : {}),
          ...(input.fit ? { fit: input.fit } : {}),
          zIndex: nextZIndex(slide),
        };
        return {
          slides: state.slides.map((s) =>
            s.id === slideId ? { ...s, videoBlocks: [...s.videoBlocks, block] } : s
          ),
          selectedBlockId: block.id,
          dirty: true,
        };
      });
    },

    updateVideoBlock: (slideId, blockId, updates) => {
      apply(
        (state) => ({
          slides: state.slides.map((s) =>
            s.id === slideId
              ? {
                  ...s,
                  videoBlocks: s.videoBlocks.map((b) => (b.id === blockId ? { ...b, ...updates } : b)),
                }
              : s
          ),
          dirty: true,
        }),
        editGroup(Object.keys(updates), slideId, blockId)
      );
    },

    removeVideoBlock: (slideId, blockId) => {
      apply((state) => ({
        slides: state.slides.map((s) =>
          s.id === slideId
            ? { ...s, videoBlocks: s.videoBlocks.filter((b) => b.id !== blockId) }
            : s
        ),
        selectedBlockId: null,
        dirty: true,
      }));
    },

    replaceVideoBlockSrc: (slideId, blockId, src) => {
      apply((state) => ({
        slides: state.slides.map((s) =>
          s.id === slideId
            ? { ...s, videoBlocks: s.videoBlocks.map((b) => (b.id === blockId ? { ...b, src } : b)) }
            : s
        ),
        dirty: true,
      }));
    },

    selectBlock: (blockId) => set({ selectedBlockId: blockId }),
  };
});
