// PPT 数据类型定义

export const FREE_PPT_LIMIT = 1;
export const FREE_SLIDE_LIMIT = 2;

export interface TextBlock {
  id: string;
  text: string;
  x: number;       // 百分比 0-100  左
  y: number;       // 百分比 0-100  上
  width: number;   // 百分比
  height?: number; // 百分比 (可选，有了才能缩放高度；旧数据无此字段时自动估算)
  fontSize: number;
  color: string;
  opacity?: number;      // 文字不透明度 0-1，缺省 1；只作用于文字，文本框填充另走 bgOpacity
  fontWeight: 'normal' | 'bold';
  fontStyle: 'normal' | 'italic';
  textAlign: 'left' | 'center' | 'right';
  // ===== 导入保真度：源文件里有但界面上不编辑的字段 =====
  fontFamily?: string;   // CSS font-family 串（如 "Georgia", "KaiTi"），缺省用全局字体
  wrap?: boolean;        // false = 源文件 wrap="none"，文字不换行；缺省按换行处理
  // ===== 新增：文本框外观 =====
  bgColor?: string;         // 文本框背景色，空=透明
  bgOpacity?: number;       // 背景透明度 0-1，默认 1
  borderRadius?: number;    // 圆角 px
  padding?: number;         // 内边距 px
  borderColor?: string;
  borderWidth?: number;
  zIndex?: number;
}

export interface Background {
  type: 'none' | 'color' | 'image' | 'video' | 'local' | 'cloud';
  value: string;
  // type==='local' 时 value 是 `local:<key>`（指向浏览器 IndexedDB 里的文件）；
  // type==='cloud' 时 value 是存储桶内路径 u{userId}/{sha256}{ext}，域名不在 deck 里，渲染时才拼；
  // type==='image'/'video' 时 value 是 https 外链或站内绝对路径。
  // name 是原始文件名，只用于界面文案，永不进 URL。
  name?: string;
}

/**
 * 正文媒体的来源。三种都不叫 `url`：cloud 分支存的只是桶内路径，
 * 拿来就能渲染的是渲染时由 NEXT_PUBLIC_MEDIA_PUBLIC_BASE 拼出来的，deck 里不存域名。
 * local 的 value 形如 `local:<key>`，key 是不透明 UUID，永不拼进 URL。
 */
export type MediaSource =
  | { kind: 'local'; value: string }
  | { kind: 'cloud'; value: string }
  | { kind: 'remote'; value: string };

/** 向后兼容别名 */
export type ImageSource = MediaSource;
export type VideoSource = MediaSource;

/** CSS object-fit 的三个值；pptx 里带裁剪/平铺的图统一按 cover 近似 */
export type ImageFit = 'fill' | 'contain' | 'cover';

export interface ImageBlock {
  id: string;
  src: ImageSource;
  x: number;       // 百分比 0-100  左
  y: number;       // 百分比 0-100  上
  width: number;   // 百分比
  height: number;  // 百分比（图片块必须有框高，否则没法缩放）
  fit?: ImageFit;  // 缺省 contain（完整显示，不裁切）
  alt?: string;    // 只用于界面与 alt 文案，永不进 URL
  zIndex?: number;
}

export interface VideoBlock {
  id: string;
  src: VideoSource;
  x: number;       // 百分比 0-100  左
  y: number;       // 百分比 0-100  上
  width: number;   // 百分比
  height: number;  // 百分比
  fit?: ImageFit;  // 缺省 contain
  alt?: string;    // 只用于界面文案，永不进 URL
  poster?: string; // https/站内绝对路径，parseRemoteUrl 校验
  loop?: boolean;  // 缺省 false
  muted?: boolean; // 缺省 true（自动播放策略要求）
  controls?: boolean; // 缺省 false（放映手势层/编辑器拖拽优先）
  zIndex?: number;
}

export interface Slide {
  id: string;
  background: Background;
  textBlocks: TextBlock[];
  imageBlocks: ImageBlock[];
  videoBlocks: VideoBlock[];
}

export interface Presentation {
  id: number;
  title: string;
  data: Slide[];
  category_id?: number | null;
}

// ===== 默认值 =====
export function createEmptySlide(): Slide {
  return {
    id: crypto.randomUUID(),
    background: { type: 'color', value: '#1a1a2e' },
    textBlocks: [
      {
        id: crypto.randomUUID(),
        text: '在此输入标题',
        x: 10, y: 30, width: 80, height: 20,
        fontSize: 48, color: '#ffffff',
        fontWeight: 'bold', fontStyle: 'normal', textAlign: 'center',
      },
    ],
    imageBlocks: [],
    videoBlocks: [],
  };
}

export function createDefaultPresentation(): Slide[] {
  return [
    {
      id: crypto.randomUUID(),
      background: { type: 'color', value: '#1a1a2e' },
      textBlocks: [
        {
          id: crypto.randomUUID(),
          text: '欢迎使用 PPT 播放器',
          x: 10, y: 25, width: 80, height: 20,
          fontSize: 56, color: '#ffffff',
          fontWeight: 'bold', fontStyle: 'normal', textAlign: 'center',
        },
        {
          id: crypto.randomUUID(),
          text: '在线编辑 · 全屏播放 · 自动保存',
          x: 10, y: 55, width: 80, height: 12,
          fontSize: 24, color: '#a0a0a0',
          fontWeight: 'normal', fontStyle: 'normal', textAlign: 'center',
        },
      ],
      imageBlocks: [],
      videoBlocks: [],
    },
    {
      id: crypto.randomUUID(),
      background: { type: 'color', value: '#16213e' },
      textBlocks: [
        {
          id: crypto.randomUUID(),
          text: '功能特点',
          x: 10, y: 12, width: 80, height: 15,
          fontSize: 42, color: '#e94560',
          fontWeight: 'bold', fontStyle: 'normal', textAlign: 'center',
        },
        {
          id: crypto.randomUUID(),
          text: '✓ 添加多张幻灯片\n✓ 设置文字大小、颜色\n✓ 图片/视频背景\n✓ 大屏全屏播放',
          x: 15, y: 35, width: 70, height: 45,
          fontSize: 28, color: '#ffffff',
          fontWeight: 'normal', fontStyle: 'normal', textAlign: 'left',
        },
      ],
      imageBlocks: [],
      videoBlocks: [],
    },
  ];
}
