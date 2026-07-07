"use client";

import { Player } from "@remotion/player";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig
} from "remotion";
import type { VisibilitySnapshot } from "@/lib/report/schema";

interface VisibilityTransformationPlayerProps {
  companyName: string;
  snapshot: VisibilitySnapshot;
}

export function VisibilityTransformationPlayer({
  companyName,
  snapshot
}: VisibilityTransformationPlayerProps) {
  return (
    <div className="remotion-shell">
      <Player
        autoPlay
        loop
        component={VisibilityTransformationComposition}
        compositionHeight={720}
        compositionWidth={1280}
        durationInFrames={180}
        fps={30}
        inputProps={{ companyName, snapshot }}
        style={{
          aspectRatio: "16 / 9",
          width: "100%"
        }}
      />
    </div>
  );
}

function VisibilityTransformationComposition({
  companyName,
  snapshot
}: VisibilityTransformationPlayerProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const intro = spring({ frame, fps, config: { damping: 18, stiffness: 90 } });
  const lift = spring({ frame: frame - 34, fps, config: { damping: 18, stiffness: 80 } });
  const pulse = interpolate(Math.sin(frame / 12), [-1, 1], [0.94, 1.04]);

  const currentAi = interpolate(intro, [0, 1], [0, snapshot.currentAiVisibilityScore]);
  const targetAi = interpolate(lift, [0, 1], [snapshot.currentAiVisibilityScore, snapshot.targetAiVisibilityScore]);
  const currentReddit = interpolate(intro, [0, 1], [0, snapshot.currentRedditPresenceScore]);
  const targetReddit = interpolate(
    lift,
    [0, 1],
    [snapshot.currentRedditPresenceScore, snapshot.targetRedditPresenceScore]
  );

  return (
    <AbsoluteFill className="motion-frame">
      <div className="motion-grid">
        <div className="motion-copy">
          <span>AI Search Opportunity</span>
          <h2>{companyName}</h2>
          <p>{snapshot.summary}</p>
          <strong>
            {snapshot.estimatedMonthlyOpportunityTraffic?.toLocaleString() ?? "Uncaptured"} monthly
            opportunity signals
          </strong>
        </div>

        <div className="motion-dashboard">
          <ScoreLane
            label="AI answer visibility"
            currentValue={currentAi}
            targetValue={targetAi}
            pulse={pulse}
          />
          <ScoreLane
            label="Reddit buyer presence"
            currentValue={currentReddit}
            targetValue={targetReddit}
            pulse={pulse}
          />
          <div className="motion-path">
            <div>Now</div>
            <div>Useful sources</div>
            <div>Reddit proof</div>
            <div>AI mentions</div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
}

function ScoreLane({
  label,
  currentValue,
  targetValue,
  pulse
}: {
  label: string;
  currentValue: number;
  targetValue: number;
  pulse: number;
}) {
  return (
    <div className="motion-lane">
      <div className="motion-lane-top">
        <strong>{label}</strong>
        <span>{Math.round(targetValue)}/100</span>
      </div>
      <div className="motion-bars">
        <div className="motion-bar muted">
          <span style={{ width: `${Math.max(4, currentValue)}%` }} />
        </div>
        <div className="motion-bar active">
          <span
            style={{
              transform: `scaleX(${Math.max(0.04, targetValue / 100)}) scaleY(${pulse})`
            }}
          />
        </div>
      </div>
    </div>
  );
}
