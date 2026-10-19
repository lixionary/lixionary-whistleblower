import type { SVGProps } from "react";

export interface LogoMarkProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

export function LogoMark({
  size = 28,
  className = "",
  style,
  ...props
}: LogoMarkProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 512 512"
      width={size}
      height={size}
      fill="none"
      className={`brand-logo-mark ${className}`.trim()}
      style={{ display: "inline-block", flexShrink: 0, ...style }}
      aria-hidden="true"
      {...props}
    >
      <defs>
        <linearGradient id="suite-shield-rim-left" x1="102" y1="54" x2="256" y2="462" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#38bdf8" />
          <stop offset="25%" stopColor="#6366f1" />
          <stop offset="65%" stopColor="#4338ca" />
          <stop offset="100%" stopColor="#312e81" />
        </linearGradient>

        <linearGradient id="suite-shield-rim-right" x1="410" y1="54" x2="256" y2="462" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#fbbf24" />
          <stop offset="25%" stopColor="#f59e0b" />
          <stop offset="45%" stopColor="#b45309" />
          <stop offset="75%" stopColor="#4338ca" />
          <stop offset="100%" stopColor="#1e1b4b" />
        </linearGradient>

        <linearGradient id="suite-inner-left" x1="138" y1="92" x2="256" y2="420" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#2a2e4a" />
          <stop offset="50%" stopColor="#181b2f" />
          <stop offset="100%" stopColor="#0e101d" />
        </linearGradient>

        <linearGradient id="suite-inner-right" x1="374" y1="92" x2="256" y2="420" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#1d1f30" />
          <stop offset="50%" stopColor="#131422" />
          <stop offset="100%" stopColor="#0a0b12" />
        </linearGradient>

        <linearGradient id="suite-wave-grad-1" x1="184" y1="332" x2="216" y2="232" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#4f46e5" />
          <stop offset="50%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#38bdf8" />
        </linearGradient>

        <linearGradient id="suite-wave-grad-2" x1="216" y1="368" x2="270" y2="188" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#4338ca" />
          <stop offset="40%" stopColor="#6366f1" />
          <stop offset="85%" stopColor="#38bdf8" />
          <stop offset="100%" stopColor="#a5f3fc" />
        </linearGradient>

        <linearGradient id="suite-wave-grad-3" x1="250" y1="404" x2="336" y2="156" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#3730a3" />
          <stop offset="35%" stopColor="#4f46e5" />
          <stop offset="70%" stopColor="#6366f1" />
          <stop offset="90%" stopColor="#38bdf8" />
          <stop offset="100%" stopColor="#fde68a" />
        </linearGradient>

        <filter id="suite-shield-shadow" x="-20%" y="-10%" width="140%" height="130%">
          <feDropShadow dx="0" dy="16" stdDeviation="22" floodColor="#000000" floodOpacity="0.55" />
          <feDropShadow dx="0" dy="4" stdDeviation="8" floodColor="#4f46e5" floodOpacity="0.3" />
        </filter>
      </defs>

      <g filter="url(#suite-shield-shadow)">
        {/* Outer Shield Bevel Left */}
        <path
          d="M 256,54 L 102,118 L 102,266 C 102,342 166,412 256,462 L 256,420 C 188,376 138,318 138,256 L 138,142 L 256,92 Z"
          fill="url(#suite-shield-rim-left)"
        />

        {/* Outer Shield Bevel Right */}
        <path
          d="M 256,54 L 410,118 L 410,266 C 410,342 346,412 256,462 L 256,420 C 324,376 374,318 374,256 L 374,142 L 256,92 Z"
          fill="url(#suite-shield-rim-right)"
        />

        {/* Top Apex Glint */}
        <path
          d="M 234,63 L 256,54 L 278,63 L 268,70 L 256,65 L 244,70 Z"
          fill="#ffffff"
          opacity="0.95"
        />

        {/* Inner Shield Face Left */}
        <path
          d="M 256,92 L 138,142 L 138,256 C 138,318 188,376 256,420 Z"
          fill="url(#suite-inner-left)"
        />

        {/* Inner Shield Face Right */}
        <path
          d="M 256,92 L 374,142 L 374,256 C 374,318 324,376 256,420 Z"
          fill="url(#suite-inner-right)"
        />

        {/* Facet Dividing Ridge */}
        <line x1="256" y1="92" x2="256" y2="420" stroke="#373d60" strokeWidth="1.5" opacity="0.6" />
        <line x1="256" y1="54" x2="256" y2="92" stroke="#f1f5f9" strokeWidth="2" opacity="0.85" />

        {/* Voice Resonance Waves */}
        <path
          d="M 184,332 C 182,292 195,254 216,232"
          fill="none"
          stroke="url(#suite-wave-grad-1)"
          strokeWidth="26"
          strokeLinecap="round"
        />

        <path
          d="M 216,368 C 218,300 240,230 270,188"
          fill="none"
          stroke="url(#suite-wave-grad-2)"
          strokeWidth="26"
          strokeLinecap="round"
        />

        <path
          d="M 250,404 C 258,312 290,214 336,156"
          fill="none"
          stroke="url(#suite-wave-grad-3)"
          strokeWidth="26"
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}
