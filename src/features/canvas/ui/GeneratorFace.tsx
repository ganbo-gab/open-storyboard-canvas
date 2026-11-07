import { AudioLines, FileText, Film, ImageIcon, LayoutGrid, LoaderCircle } from 'lucide-react';

const ICONS = {
  image: ImageIcon,
  video: Film,
  text: FileText,
  audio: AudioLines,
  storyboard: LayoutGrid,
} as const;

type GeneratorFaceProps = {
  kind: keyof typeof ICONS;
  /** Corner chip with the most telling setting: ratio, duration, input count… */
  badge?: string | null;
  caption?: string;
  generating?: boolean;
};

/** Canvas face of a generator node: what it will make, and the prompt it will make it from. */
export function GeneratorFace({ kind, badge, caption, generating }: GeneratorFaceProps) {
  const Icon = ICONS[kind];
  const trimmed = caption?.trim() ?? '';

  return (
    <div className="gen-face">
      <div className="gen-face__well">
        {generating ? (
          <LoaderCircle className="gen-face__spin h-6 w-6" aria-hidden="true" />
        ) : (
          <Icon className="h-7 w-7" strokeWidth={1.25} aria-hidden="true" />
        )}
        {badge ? <span className="gen-face__badge">{badge}</span> : null}
      </div>
      {trimmed ? <p className="gen-face__caption">{trimmed}</p> : null}
    </div>
  );
}
