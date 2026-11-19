// Built-in dark themes. bg/text drive the colour engine; secondary/link are used by the UI swatches.
// "word" reproduces Microsoft Word's dark mode (measured from reference screenshots).

export const THEMES = [
  { id: "word", name: "Word Dark", bg: "#262626", text: "#F6F6F6", link: "#6CA9F5", note: "Matches Microsoft Word's dark mode" },
  { id: "amoled", name: "AMOLED Black", bg: "#000000", text: "#E8E8E8", link: "#8AB4F8" },
  { id: "deep-black", name: "Deep Black", bg: "#0B0B0B", text: "#E0E0E0", link: "#8AB4F8" },
  { id: "dark-gray", name: "Dark Gray", bg: "#1E1E1E", text: "#D4D4D4", link: "#7CB7FF" },
  { id: "standard-gray", name: "Standard Gray", bg: "#2D2D2D", text: "#E0E0E0", link: "#8AB4F8" },
  { id: "charcoal", name: "Charcoal", bg: "#232629", text: "#D8DADC", link: "#7FB0E8" },
  { id: "soft-dark", name: "Soft Dark", bg: "#33363B", text: "#D0D3D8", link: "#8EB8F0" },
  { id: "warm-dark", name: "Warm Dark", bg: "#1F1B18", text: "#E6DDD3", link: "#E8A66B" },
  { id: "sepia-dark", name: "Sepia Dark", bg: "#2A2118", text: "#D9C8A9", link: "#D9A25B" },
  { id: "cool-dark", name: "Cool Dark", bg: "#161B22", text: "#D6DEE8", link: "#79B8FF" },
  { id: "blue-dark", name: "Blue Dark", bg: "#0F1A2B", text: "#D8E4F5", link: "#7DB3FF" },
  { id: "midnight", name: "Midnight Blue", bg: "#0A1128", text: "#CFD8F0", link: "#7AA2FF" },
  { id: "green-dark", name: "Green Dark", bg: "#0F1C14", text: "#D3E8D8", link: "#7FD99A" },
  { id: "high-contrast", name: "High Contrast", bg: "#000000", text: "#FFFFFF", link: "#FFD400" },
  { id: "night-red", name: "Night Red", bg: "#140A0A", text: "#E8B4A8", link: "#FF8A75", note: "Low blue light for night reading" },
];

export const DEFAULT_THEME_ID = "word";
