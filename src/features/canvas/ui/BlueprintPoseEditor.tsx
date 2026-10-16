import { memo, useCallback } from 'react';

import type { BlueprintActionPose } from '@/features/canvas/domain/canvasNodes';

/**
 * Bone-rotation sliders for a custom person action. Each row drives one
 * Euler-rotation channel on a `BlueprintActionPose`. Values are kept in
 * radians on disk (to match Three.js native rotation units), but the
 * sliders show degrees so the user can dial in poses with familiar
 * physical intuition (90° = right angle, 180° = back-flip, etc).
 *
 * The component is fully controlled — the parent (typically the custom
 * action modal) owns the pose state and re-renders on every change. Any
 * channels left at 0 are simply omitted from the saved pose object so
 * future readers don't have to filter zeros themselves.
 */
export interface BlueprintPoseEditorProps {
  pose: BlueprintActionPose;
  onChange: (next: BlueprintActionPose) => void;
}

type BoneAxisKey = 'leftShoulder' | 'rightShoulder' | 'leftHip' | 'rightHip' | 'head';
type SingleAxisKey = 'leftElbow' | 'rightElbow' | 'leftKnee' | 'rightKnee' | 'torso';

const RAD_PER_DEG = Math.PI / 180;
const DEG_PER_RAD = 180 / Math.PI;

const SLIDER_GROUPS: Array<{
  title: string;
  rows: Array<{ label: string; bone: BoneAxisKey | SingleAxisKey; axis: 'x' | 'y' | 'z'; range?: [number, number] }>;
}> = [
  {
    title: '上身 / 头',
    rows: [
      { label: '上身 前后倾', bone: 'torso', axis: 'x', range: [-45, 45] },
      { label: '头部 仰俯', bone: 'head', axis: 'x', range: [-60, 60] },
      { label: '头部 左右转', bone: 'head', axis: 'y', range: [-150, 150] },
    ],
  },
  {
    title: '左臂',
    rows: [
      { label: '左肩 前后', bone: 'leftShoulder', axis: 'x', range: [-180, 180] },
      { label: '左肩 外展', bone: 'leftShoulder', axis: 'z', range: [-90, 90] },
      { label: '左肘 弯曲', bone: 'leftElbow', axis: 'x', range: [-150, 0] },
    ],
  },
  {
    title: '右臂',
    rows: [
      { label: '右肩 前后', bone: 'rightShoulder', axis: 'x', range: [-180, 180] },
      { label: '右肩 外展', bone: 'rightShoulder', axis: 'z', range: [-90, 90] },
      { label: '右肘 弯曲', bone: 'rightElbow', axis: 'x', range: [-150, 0] },
    ],
  },
  {
    title: '左腿',
    rows: [
      { label: '左髋 前后', bone: 'leftHip', axis: 'x', range: [-120, 90] },
      { label: '左膝 弯曲', bone: 'leftKnee', axis: 'x', range: [-160, 0] },
    ],
  },
  {
    title: '右腿',
    rows: [
      { label: '右髋 前后', bone: 'rightHip', axis: 'x', range: [-120, 90] },
      { label: '右膝 弯曲', bone: 'rightKnee', axis: 'x', range: [-160, 0] },
    ],
  },
];

function readChannel(pose: BlueprintActionPose, bone: BoneAxisKey | SingleAxisKey, axis: 'x' | 'y' | 'z'): number {
  const target = (pose as any)[bone] as { x?: number; y?: number; z?: number } | undefined;
  if (!target) return 0;
  return typeof target[axis] === 'number' ? (target[axis] as number) : 0;
}

function writeChannel(
  pose: BlueprintActionPose,
  bone: BoneAxisKey | SingleAxisKey,
  axis: 'x' | 'y' | 'z',
  rad: number,
): BlueprintActionPose {
  const next: BlueprintActionPose = { ...pose };
  const current = ((pose as any)[bone] ?? {}) as { x?: number; y?: number; z?: number };
  const updated = { ...current };
  if (Math.abs(rad) < 1e-4) {
    delete updated[axis];
  } else {
    updated[axis] = rad;
  }
  if (Object.keys(updated).length === 0) {
    delete (next as any)[bone];
  } else {
    (next as any)[bone] = updated;
  }
  return next;
}

export const BlueprintPoseEditor = memo(function BlueprintPoseEditor({ pose, onChange }: BlueprintPoseEditorProps) {
  const handleAxisChange = useCallback(
    (bone: BoneAxisKey | SingleAxisKey, axis: 'x' | 'y' | 'z', degrees: number) => {
      onChange(writeChannel(pose, bone, axis, degrees * RAD_PER_DEG));
    },
    [onChange, pose],
  );

  const handleScaleY = useCallback(
    (value: number) => {
      const next: BlueprintActionPose = { ...pose };
      if (Math.abs(value - 1) < 1e-3) delete next.scaleY;
      else next.scaleY = value;
      onChange(next);
    },
    [onChange, pose],
  );

  const handleGroupY = useCallback(
    (value: number) => {
      const next: BlueprintActionPose = { ...pose };
      if (Math.abs(value) < 1e-3) delete next.groupY;
      else next.groupY = value;
      onChange(next);
    },
    [onChange, pose],
  );

  const handleReset = useCallback(() => onChange({}), [onChange]);

  return (
    <div className="rounded-lg border border-white/10 bg-black/18 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[11px] font-semibold text-white/72">姿态控制</div>
        <button
          type="button"
          onClick={handleReset}
          className="rounded-sm bg-white/8 px-2 py-0.5 text-[10px] text-white/65 hover:bg-white/14 hover:text-white"
        >
          重置
        </button>
      </div>

      <div className="ui-scrollbar nowheel max-h-[300px] space-y-3 overflow-y-auto pr-1">
        {SLIDER_GROUPS.map((group) => (
          <div key={group.title}>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-white/35">{group.title}</div>
            <div className="space-y-1">
              {group.rows.map((row) => {
                const radians = readChannel(pose, row.bone, row.axis);
                const degrees = Math.round(radians * DEG_PER_RAD);
                const [min, max] = row.range ?? [-180, 180];
                return (
                  <PoseSliderRow
                    key={`${row.bone}-${row.axis}`}
                    label={row.label}
                    value={degrees}
                    min={min}
                    max={max}
                    onChange={(deg) => handleAxisChange(row.bone, row.axis, deg)}
                  />
                );
              })}
            </div>
          </div>
        ))}

        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wide text-white/35">整体</div>
          <PoseSliderRow
            label="高度缩放"
            value={Math.round((pose.scaleY ?? 1) * 100)}
            min={50}
            max={120}
            unit="%"
            onChange={(v) => handleScaleY(v / 100)}
          />
          <PoseSliderRow
            label="高度偏移 (m)"
            value={Math.round((pose.groupY ?? 0) * 100) / 100}
            min={-1}
            max={1}
            step={0.05}
            unit="m"
            onChange={handleGroupY}
          />
        </div>
      </div>
    </div>
  );
});

interface PoseSliderRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (next: number) => void;
}

function PoseSliderRow({ label, value, min, max, step = 1, unit = '°', onChange }: PoseSliderRowProps) {
  return (
    <label className="grid grid-cols-[88px_minmax(0,1fr)_56px] items-center gap-2 text-[10px]">
      <span className="text-white/65">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        className="nodrag nopan"
      />
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        className="nodrag nopan rounded-sm border border-white/10 bg-white/5 px-1 py-0.5 text-[10px] text-white/85 outline-hidden focus:border-accent/50"
        title={`${label} (${unit})`}
      />
    </label>
  );
}
