import type { BlueprintBodyControls, BlueprintItem } from '@/features/canvas/domain/canvasNodes';

export type DirectorStudioModelCategoryId =
  | 'basic'
  | 'people'
  | 'props'
  | 'scenes'
  | 'vehicles'
  | 'mine';

export type DirectorStudioModelKind =
  | 'person'
  | 'cube'
  | 'sphere'
  | 'cylinder'
  | 'cone'
  | 'torus'
  | 'plane'
  | 'ramp'
  | 'pipe'
  | 'terrain'
  | 'furniture'
  | 'tool'
  | 'building'
  | 'vehicle'
  | 'empty';

export interface DirectorStudioModelCategory {
  id: DirectorStudioModelCategoryId;
  labelKey: string;
}

export interface DirectorStudioModelCatalogItem {
  id: string;
  categoryId: Exclude<DirectorStudioModelCategoryId, 'mine'>;
  displayName: string;
  labelBase: string;
  itemCategory: NonNullable<BlueprintItem['category']>;
  presetId: string;
  color: string;
  thumbnailKind: DirectorStudioModelKind;
  visualId?: string;
  bodyControls?: BlueprintBodyControls;
}

export const DIRECTOR_STUDIO_MODEL_CATEGORIES: readonly DirectorStudioModelCategory[] = [
  { id: 'basic', labelKey: 'directorStudio.modelLibrary.categories.basic' },
  { id: 'people', labelKey: 'directorStudio.modelLibrary.categories.people' },
  { id: 'props', labelKey: 'directorStudio.modelLibrary.categories.props' },
  { id: 'scenes', labelKey: 'directorStudio.modelLibrary.categories.scenes' },
  { id: 'vehicles', labelKey: 'directorStudio.modelLibrary.categories.vehicles' },
  { id: 'mine', labelKey: 'directorStudio.modelLibrary.categories.mine' },
] as const;

const basicModels = [
  ['female', '女', '女人', 'person', 'woman', '#f472b6', 'person', 'person-female'],
  ['male', '男', '男人', 'person', 'man', '#60a5fa', 'person', 'person-male'],
  ['terrain', '地形', '地形', 'object', 'terrain', '#86efac', 'terrain', 'terrain'],
  ['pipe', '管道', '管道', 'object', 'pipe', '#94a3b8', 'pipe', 'pipe'],
  ['cube', '立方体', '立方体', 'object', 'cube', '#a78bfa', 'cube', 'cube'],
  ['sphere', '球体', '球体', 'object', 'sphere', '#38bdf8', 'sphere', 'sphere'],
  ['ramp', '斜坡', '斜坡', 'object', 'ramp', '#f59e0b', 'ramp', 'ramp'],
  ['torus', '圆环体', '圆环体', 'object', 'torus', '#fb7185', 'torus', 'torus'],
  ['cylinder', '圆柱体', '圆柱体', 'object', 'cylinder', '#2dd4bf', 'cylinder', 'cylinder'],
  ['cone', '圆锥体', '圆锥体', 'object', 'cone', '#f97316', 'cone', 'cone'],
  ['plane', '平面', '平面', 'object', 'plane', '#cbd5e1', 'plane', 'plane'],
  ['disc', '圆盘', '圆盘', 'object', 'disc', '#e2e8f0', 'plane', 'disc'],
] as const;

const peopleModels: Array<{
  id: string;
  displayName: string;
  presetId: string;
  color: string;
  visualId: string;
  bodyControls?: BlueprintBodyControls;
}> = [
  { id: 'adult-male-average', displayName: '成年-男性', presetId: 'person-adult-male-average', color: '#60a5fa', visualId: 'person-adult-male' },
  { id: 'adult-female-average', displayName: '成年-女性', presetId: 'person-adult-female-average', color: '#f472b6', visualId: 'person-adult-female' },
  { id: 'adult-male-slim', displayName: '瘦-成年-男性', presetId: 'person-adult-male-slim', color: '#38bdf8', visualId: 'person-adult-male-slim', bodyControls: { style: 'slim' } },
  { id: 'adult-female-slim', displayName: '瘦-成年-女性', presetId: 'person-adult-female-slim', color: '#f9a8d4', visualId: 'person-adult-female-slim', bodyControls: { style: 'slim' } },
  { id: 'adult-male-strong', displayName: '壮-成年-男性', presetId: 'person-adult-male-strong', color: '#2563eb', visualId: 'person-adult-male-strong', bodyControls: { style: 'strong' } },
  { id: 'adult-female-strong', displayName: '壮-成年-女性', presetId: 'person-adult-female-strong', color: '#fb7185', visualId: 'person-adult-female-strong', bodyControls: { style: 'strong' } },
  { id: 'adult-male-heavy', displayName: '胖-成年-男性', presetId: 'person-adult-male-heavy', color: '#818cf8', visualId: 'person-adult-male-heavy', bodyControls: { style: 'heavy' } },
  { id: 'adult-female-heavy', displayName: '胖-成年-女性', presetId: 'person-adult-female-heavy', color: '#f0abfc', visualId: 'person-adult-female-heavy', bodyControls: { style: 'heavy' } },
  { id: 'elder-male', displayName: '老年-男性', presetId: 'person-elder-male', color: '#cbd5e1', visualId: 'person-elder-male', bodyControls: { core: { height: 0.94, torsoLeanDeg: -8 } } },
  { id: 'elder-female', displayName: '老年-女性', presetId: 'person-elder-female', color: '#e9d5ff', visualId: 'person-elder-female', bodyControls: { core: { height: 0.9, torsoLeanDeg: -8 } } },
  { id: 'child-boy', displayName: '儿童-男', presetId: 'person-child-boy', color: '#fde68a', visualId: 'person-child-boy', bodyControls: { style: 'childlike' } },
  { id: 'child-girl', displayName: '儿童-女', presetId: 'person-child-girl', color: '#fbcfe8', visualId: 'person-child-girl', bodyControls: { style: 'childlike' } },
  { id: 'teen-male', displayName: '青少年-男', presetId: 'person-teen-male', color: '#93c5fd', visualId: 'person-teen-male', bodyControls: { core: { height: 0.9, headScale: 1.08 }, arms: { thickness: 0.92 }, legs: { thickness: 0.92 } } },
  { id: 'teen-female', displayName: '青少年-女', presetId: 'person-teen-female', color: '#fda4af', visualId: 'person-teen-female', bodyControls: { core: { height: 0.88, headScale: 1.08 }, arms: { thickness: 0.88 }, legs: { thickness: 0.88 } } },
  { id: 'construction-worker', displayName: '建筑工人', presetId: 'person-construction-worker', color: '#f59e0b', visualId: 'person-construction-worker', bodyControls: { style: 'strong' } },
  { id: 'medical-worker', displayName: '医护人员', presetId: 'person-medical-worker', color: '#a7f3d0', visualId: 'person-medical-worker' },
  { id: 'security-officer', displayName: '安保人员', presetId: 'person-security-officer', color: '#64748b', visualId: 'person-security-officer', bodyControls: { style: 'strong' } },
  { id: 'stage-performer', displayName: '舞台表演者', presetId: 'person-stage-performer', color: '#e879f9', visualId: 'person-stage-performer', bodyControls: { style: 'slim' } },
  { id: 'raincoat', displayName: '雨衣人物', presetId: 'person-raincoat', color: '#facc15', visualId: 'person-raincoat' },
];

const propModels = [
  ['chair', '椅子', 'chair', '#92400e', 'furniture', 'prop-chair'],
  ['office-chair', '办公椅', 'office-chair', '#334155', 'furniture', 'prop-office-chair'],
  ['stool', '凳子', 'stool', '#b45309', 'furniture', 'prop-stool'],
  ['table', '桌子', 'table', '#d97706', 'furniture', 'prop-table'],
  ['desk', '书桌', 'desk', '#a16207', 'furniture', 'prop-desk'],
  ['sofa', '沙发', 'sofa', '#f59e0b', 'furniture', 'prop-sofa'],
  ['bed', '床', 'bed', '#c084fc', 'furniture', 'prop-bed'],
  ['cabinet', '柜子', 'cabinet', '#a16207', 'furniture', 'prop-cabinet'],
  ['bookshelf', '书架', 'bookshelf', '#854d0e', 'furniture', 'prop-bookshelf'],
  ['door', '门', 'door', '#78350f', 'furniture', 'prop-door'],
  ['window', '窗', 'window', '#7dd3fc', 'furniture', 'prop-window'],
  ['floor-lamp', '落地灯', 'floor-lamp', '#fde047', 'furniture', 'prop-floor-lamp'],
  ['table-lamp', '台灯', 'table-lamp', '#facc15', 'furniture', 'prop-table-lamp'],
  ['plant', '绿植', 'plant', '#34d399', 'furniture', 'prop-plant'],
  ['laptop', '笔记本电脑', 'laptop', '#475569', 'tool', 'prop-laptop'],
  ['phone', '手机', 'phone', '#94a3b8', 'tool', 'prop-phone'],
  ['cup', '水杯', 'cup', '#f8fafc', 'tool', 'prop-cup'],
  ['suitcase', '行李箱', 'suitcase', '#0f766e', 'furniture', 'prop-suitcase'],
  ['monitor-tv', '电视/监视器', 'monitor-tv', '#0f172a', 'furniture', 'prop-monitor-tv'],
] as const;

const sceneModels = [
  ['living-room', '客厅', '#7dd3fc', 'scene-living-room'],
  ['kitchen', '厨房', '#bae6fd', 'scene-kitchen'],
  ['bedroom', '卧室', '#c4b5fd', 'scene-bedroom'],
  ['office', '办公室', '#93c5fd', 'scene-office'],
  ['classroom', '教室', '#fbbf24', 'scene-classroom'],
  ['hospital-room', '病房', '#bfdbfe', 'scene-hospital-room'],
  ['shop-cafe', '店铺/咖啡店', '#f59e0b', 'scene-shop-cafe'],
  ['restaurant', '餐厅', '#fb7185', 'scene-restaurant'],
  ['street-corner', '街角', '#64748b', 'scene-street-corner'],
  ['parking-lot', '停车场', '#94a3b8', 'scene-parking-lot'],
  ['park-path', '公园小路', '#86efac', 'scene-park-path'],
  ['warehouse', '仓库', '#a3a3a3', 'scene-warehouse'],
  ['house-exterior', '住宅外立面', '#7dd3fc', 'scene-house-exterior'],
  ['apartment-exterior', '公寓外立面', '#93c5fd', 'scene-apartment-exterior'],
] as const;

const vehicleModels = [
  ['sedan', '轿车', '#ef4444'],
  ['suv', 'SUV', '#0ea5e9'],
  ['taxi', '出租车', '#facc15'],
  ['van', '面包车', '#94a3b8'],
  ['bus', '公交车', '#facc15'],
  ['truck', '货车', '#475569'],
  ['motorcycle', '摩托车', '#111827'],
  ['bicycle', '自行车', '#0f766e'],
  ['e-scooter', '电动车/踏板车', '#14b8a6'],
  ['ambulance', '救护车', '#f8fafc'],
  ['police-car', '警车', '#1d4ed8'],
  ['subway-car', '地铁/列车车厢', '#e2e8f0'],
] as const;

export const DIRECTOR_STUDIO_MODEL_CATALOG: readonly DirectorStudioModelCatalogItem[] = [
  ...basicModels.map(([id, displayName, labelBase, itemCategory, presetId, color, thumbnailKind, visualId]) => ({
    id: `basic-${id}`,
    categoryId: 'basic' as const,
    displayName,
    labelBase,
    itemCategory,
    presetId,
    color,
    thumbnailKind,
    visualId,
  })),
  ...peopleModels.map((model) => ({
    id: `people-${model.id}`,
    categoryId: 'people' as const,
    displayName: model.displayName,
    labelBase: model.displayName,
    itemCategory: 'person' as const,
    presetId: model.presetId,
    color: model.color,
    thumbnailKind: 'person' as const,
    visualId: model.visualId,
    bodyControls: model.bodyControls,
  })),
  ...propModels.map(([id, displayName, presetId, color, thumbnailKind, visualId]) => ({
    id: `props-${id}`,
    categoryId: 'props' as const,
    displayName,
    labelBase: displayName,
    itemCategory: 'object' as const,
    presetId,
    color,
    thumbnailKind,
    visualId,
  })),
  ...sceneModels.map(([id, displayName, color, visualId]) => ({
    id: `scenes-${id}`,
    categoryId: 'scenes' as const,
    displayName,
    labelBase: displayName,
    itemCategory: 'scene' as const,
    presetId: `scene-${id}`,
    color,
    thumbnailKind: 'building' as const,
    visualId,
  })),
  ...vehicleModels.map(([id, displayName, color]) => ({
    id: `vehicles-${id}`,
    categoryId: 'vehicles' as const,
    displayName,
    labelBase: displayName,
    itemCategory: 'object' as const,
    presetId: `vehicle-${id}`,
    color,
    thumbnailKind: 'vehicle' as const,
    visualId: `vehicle-${id}`,
  })),
] as const;

const LEGACY_DIRECTOR_STUDIO_MODEL_LABELS: Record<string, string> = {
  'person-construction-worker-05': '建筑工人-05',
  'person-bailiff-police': '警察-法警',
  'person-swat-police': '警察-特警',
  'person-firefighter-01': '消防员-01',
  'person-firefighter-02': '消防员-02',
  'person-firefighter-03': '消防员-03',
  'person-doctor-01': '医生-01',
  'person-doctor-02': '医生-02',
  'person-doctor-03': '医生-03',
  'person-doctor-04': '医生-04',
  'person-doctor-05': '医生-05',
  'person-doctor-06': '医生-06',
  'drum-stool': '鼓凳',
  'folding-chair': '交椅',
  'official-chair': '官帽椅',
  screen: '屏风',
  knife: '刀',
  shield: '盾',
  bow: '弓箭',
  'scene-villa-01': '别墅01',
  'scene-villa-02': '别墅02',
  'scene-city-cluster': '城市群',
  'scene-octagonal-tower': '八角塔',
  'scene-city-gate': '城楼',
  'scene-city-wall': '城墙',
  'scene-main-hall': '大殿',
  'scene-paifang': '牌坊',
  'scene-building-01': '建筑01',
  'scene-building-02': '建筑02',
  'scene-concept-scene': '概念场景',
  'scene-concept-scene-01': '概念场景01',
  'vehicle-helicopter': '直升机',
  'vehicle-sedan-01': '轿车01',
  'vehicle-tank': '坦克',
  'vehicle-ship': '轮船',
  'vehicle-submarine': '潜艇',
  'vehicle-yacht': '游艇',
  'vehicle-sedan-chair': '轿子',
};

export const DIRECTOR_STUDIO_MODEL_LABELS: Record<string, string> = Object.fromEntries(
  [
    ...Object.entries(LEGACY_DIRECTOR_STUDIO_MODEL_LABELS),
    ...DIRECTOR_STUDIO_MODEL_CATALOG.map((item) => [item.presetId, item.displayName] as const),
  ],
);
