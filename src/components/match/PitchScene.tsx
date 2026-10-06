import { useId } from "react";
import { isActionAnim } from "./pitchFrames";
import type { MatchFrame, MinuteFrames } from "./types";

interface Props {
  data: MinuteFrames | null;
  frame: MatchFrame | null;
  homeColor: string;
  awayColor: string;
  label: string;
  jerseys?: ReadonlyMap<string, number>;
  names?: ReadonlyMap<string, string>;
}

/** Responsive SVG keeps labels crisp and exposes player names without a graphics dependency. */
export function PitchScene({ data, frame, homeColor, awayColor, label, jerseys, names }: Props) {
  const id = useId().replace(/:/g, "");
  const length = data?.pitch_length ?? 105;
  const width = data?.pitch_width ?? 68;
  return (
    <svg
      viewBox={`-4 -4 ${length + 8} ${width + 8}`}
      role="img"
      aria-label={label}
      className="block w-full rounded-xl bg-primary-900 shadow-inner"
    >
      <defs>
        <pattern id={`net-${id}`} width="0.7" height="0.7" patternUnits="userSpaceOnUse">
          <path d="M 0.7 0 L 0 0 0 0.7" fill="none" className="stroke-white/40" strokeWidth="0.1" />
        </pattern>
      </defs>
      <rect width={length} height={width} className="fill-primary-700" />
      {Array.from({ length: 10 }, (_, i) => (
        <rect
          key={i}
          x={(i * length) / 10}
          width={length / 10}
          height={width}
          className={i % 2 ? "fill-primary-800/30" : "fill-transparent"}
        />
      ))}
      <g fill="none" className="stroke-white/70" strokeWidth="0.18">
        <rect width={length} height={width} />
        <path d={`M ${length / 2} 0 V ${width}`} />
        <circle cx={length / 2} cy={width / 2} r="9.15" />
        {[false, true].map((end) => (
          <g
            key={String(end)}
            transform={end ? `translate(${length} ${width}) rotate(180)` : undefined}
          >
            <rect x="0" y={(width - 40.32) / 2} width="16.5" height="40.32" />
            <rect x="0" y={(width - 18.32) / 2} width="5.5" height="18.32" />
            <path d={`M 16.5 ${width / 2 - 7.31} A 9.15 9.15 0 0 1 16.5 ${width / 2 + 7.31}`} />
            <circle cx="11" cy={width / 2} r="0.2" className="fill-white" />
            <rect
              x="-2.5"
              y={(width - 7.32) / 2}
              width="2.5"
              height="7.32"
              fill={`url(#net-${id})`}
              strokeWidth="0.3"
            />
            <path d={`M 1 0 A 1 1 0 0 1 0 1 M 0 ${width - 1} A 1 1 0 0 1 1 ${width}`} />
          </g>
        ))}
        <circle cx={length / 2} cy={width / 2} r="0.25" className="fill-white" />
      </g>
      {frame?.players.map((player, i) => {
        const info = data?.players[i];
        if (!info) return null;
        const number = jerseys?.get(info.player_id);
        const name = names?.get(info.player_id) ?? info.player_id;
        const home = info.side === "Home";
        const keeper = info.position === "Goalkeeper";
        return (
          <g key={info.player_id} transform={`translate(${player.x} ${player.y})`}>
            <title>{number != null ? `#${number} · ${name}` : name}</title>
            <ellipse cy="0.65" rx="1.45" ry="0.7" className="fill-black/30" />
            <g transform={`translate(0 ${-player.z})`}>
              {isActionAnim(player.anim) && (
                <circle r="2" fill="none" className="stroke-accent-400" strokeWidth="0.3" />
              )}
              <path
                d="M 1.5 -0.4 L 2.2 0 L 1.5 0.4"
                transform={`rotate(${(player.facing * 180) / Math.PI})`}
                className="fill-white"
              />
              <circle
                r="1.35"
                fill={home ? homeColor : awayColor}
                className={home ? "stroke-white" : "stroke-navy-900"}
                strokeWidth="0.3"
              />
              {keeper && (
                <circle r="1.6" fill="none" className="stroke-accent-300" strokeWidth="0.2" />
              )}
              {number != null && (
                <>
                  <circle r="0.9" className="fill-navy-900/70" />
                  <text
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize="1.35"
                    fontWeight="700"
                    className="fill-white font-sans"
                  >
                    {number}
                  </text>
                </>
              )}
            </g>
          </g>
        );
      })}
      {frame && (
        <g>
          <ellipse
            cx={frame.ball.x}
            cy={frame.ball.y + 0.3}
            rx="0.65"
            ry="0.35"
            className="fill-black/40"
          />
          <circle
            cx={frame.ball.x}
            cy={frame.ball.y - frame.ball.z * 1.4}
            r={0.55 + Math.min(frame.ball.z, 5) * 0.05}
            className="fill-white stroke-navy-900"
            strokeWidth="0.16"
          />
        </g>
      )}
    </svg>
  );
}
