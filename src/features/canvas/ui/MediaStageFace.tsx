import { Film, ImageIcon, LoaderCircle } from 'lucide-react';

type MediaStageFaceProps = {
  kind: 'image' | 'video';
  ratio?: string | null;
  caption?: string;
  generating?: boolean;
};

export function MediaStageFace({ kind, ratio, caption, generating }: MediaStageFaceProps) {
  const Icon = kind === 'video' ? Film : ImageIcon;
  const trimmed = caption?.trim() ?? '';

  return (
    <div className="stage-face">
      <div className="stage-face__well">
        {generating ? (
          <LoaderCircle className="stage-face__spin h-6 w-6" aria-hidden="true" />
        ) : (
          <Icon className="h-7 w-7" strokeWidth={1.25} aria-hidden="true" />
        )}
        {ratio ? <span className="stage-face__ratio">{ratio}</span> : null}
      </div>
      {trimmed ? <p className="stage-face__caption">{trimmed}</p> : null}
    </div>
  );
}
