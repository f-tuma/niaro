import { useState, type RefObject } from "react";
import { Pause, Play, RotateCcw, RotateCw } from "lucide-react";
import { Button } from "@admin/components/ui/button";
import { Card, CardContent } from "@admin/components/ui/card";
import { Slider } from "@admin/components/ui/slider";
import { Spinner } from "@admin/components/ui/spinner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@admin/components/ui/dropdown-menu";
import { meetingTime } from "../../../../packages/ui-catalog/meeting-format";
import type { MeetingsCopy } from "./meetings-copy";

const SPEEDS = [1, 1.25, 1.5, 1.75, 2];

/**
 * The meeting's player: play, 15 s back and forward, a position bar and the
 * speed. The sound loads on the first play or jump; until then the bar
 * shows the meeting's length.
 */
export function MeetingPlayer({
  url,
  phase,
  audio,
  onReady,
  seek,
  duration: known,
  copy,
}: {
  url: string | null;
  phase: "idle" | "loading" | "ready" | "failed";
  audio: RefObject<HTMLAudioElement | null>;
  /** Plays from a time asked for before the sound was there. */
  onReady(): void;
  seek(seconds: number): Promise<void>;
  duration: number;
  copy: MeetingsCopy;
}) {
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [length, setLength] = useState(0);
  const [speed, setSpeed] = useState(1);
  const duration = length || known;
  const element = () => audio.current;
  const toggle = () => {
    const player = element();
    if (!url || !player) void seek(current);
    else if (player.paused) void Promise.resolve(player.play()).catch(() => {});
    else player.pause();
  };
  const move = (seconds: number) => {
    const at = Math.max(0, Math.min(duration || seconds, seconds));
    setCurrent(at);
    void seek(at);
  };
  if (phase === "failed")
    return (
      <p className="text-sm text-muted-foreground">{copy.audioUnavailable}</p>
    );
  return (
    <Card size="sm">
      <CardContent>
        {url && (
          <audio
            ref={audio}
            src={url}
            preload="auto"
            className="hidden"
            onLoadedMetadata={(event) => {
              const player = event.currentTarget;
              if (Number.isFinite(player.duration)) setLength(player.duration);
              player.playbackRate = speed;
              onReady();
            }}
            onTimeUpdate={(event) =>
              setCurrent(event.currentTarget.currentTime)
            }
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
          />
        )}
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={copy.back15}
            onClick={() => move(current - 15)}
          >
            <RotateCcw aria-hidden="true" />
          </Button>
          <Button
            size="icon"
            aria-label={playing ? copy.pause : copy.play}
            disabled={phase === "loading"}
            onClick={toggle}
          >
            {phase === "loading" ? (
              <Spinner />
            ) : playing ? (
              <Pause aria-hidden="true" />
            ) : (
              <Play aria-hidden="true" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={copy.forward15}
            onClick={() => move(current + 15)}
          >
            <RotateCw aria-hidden="true" />
          </Button>
          <span className="ml-2 text-xs text-muted-foreground tabular-nums">
            {meetingTime(current)}
          </span>
          <Slider
            className="mx-3 flex-1"
            aria-label={copy.position}
            min={0}
            max={Math.max(1, duration)}
            step={1}
            value={[Math.min(current, duration || current)]}
            onValueChange={([value]) =>
              value !== undefined && setCurrent(value)
            }
            onValueCommit={([value]) => value !== undefined && move(value)}
          />
          <span className="text-xs text-muted-foreground tabular-nums">
            {meetingTime(duration)}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="ml-1"
                aria-label={copy.speed}
              >
                <span className="tabular-nums">{speed}×</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup
                value={String(speed)}
                onValueChange={(value) => {
                  const next = Number(value);
                  setSpeed(next);
                  const player = element();
                  if (player) player.playbackRate = next;
                }}
              >
                {SPEEDS.map((value) => (
                  <DropdownMenuRadioItem key={value} value={String(value)}>
                    <span className="tabular-nums">{value}×</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardContent>
    </Card>
  );
}
