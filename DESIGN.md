# Design

## Foundation

LanDrop is a restrained product UI. Users may be glancing between devices, so the interface favors clear hierarchy, stable layout, and direct controls over visual drama.

Mood phrase: electronics workbench in daylight, clean surface, labeled tools, one confident accent.

## Color

Use OKLCH custom properties only.

```css
:root {
  --bg: oklch(1 0 0);
  --surface: oklch(0.972 0.004 343.4);
  --surface-strong: oklch(0.94 0.012 343.4);
  --ink: oklch(0.17 0.018 282);
  --muted: oklch(0.43 0.025 282);
  --line: oklch(0.88 0.014 282);
  --primary: oklch(0.63 0.19 343.4);
  --primary-strong: oklch(0.52 0.2 343.4);
  --accent: oklch(0.52 0.16 205);
  --success: oklch(0.53 0.15 150);
  --warning: oklch(0.68 0.15 75);
  --danger: oklch(0.56 0.18 28);
}
```

Primary rose is reserved for the main action and active room state. Cyan-blue accent is used for secondary badges, links, and transfer direction cues. Keep large surfaces white or near-white.

## Typography

Use a system sans stack: `Inter`, `Segoe UI`, `PingFang SC`, `Microsoft YaHei`, `system-ui`, sans-serif. Product headings use fixed rem sizes, not fluid viewport scaling. Body copy is 15-16px with 1.5 line-height. Labels are 12-13px with medium weight.

## Layout

The first screen is the app, not a landing page. Desktop layout uses a left connection rail and a right activity workspace. Mobile stacks the room card, actions, and feed in that order. Panels have 8-12px radius, low-contrast borders, and minimal shadow.

## Components

Buttons are compact, icon-free unless a native symbol is clearer. File inputs use a drop target plus a normal picker button. Room code is rendered as large tabular digits. Connection status uses small pills with semantic color. Transfer cards show sender, type, time, size, and action.

## Motion

Motion is limited to state feedback: incoming item highlight, progress bar changes, and toast entrance. Transitions stay between 120ms and 220ms. Respect `prefers-reduced-motion`.

## States

Cover no peers connected, clipboard permission denied, disconnected server, upload failure, empty activity, long file names, long text snippets, and mobile narrow widths.
