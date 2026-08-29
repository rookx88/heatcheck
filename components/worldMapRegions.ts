// Configuration + geometry for the HeatCheck flash-navigation world map.
// Coordinates are in the SAME pixel space as the source artwork
// (assets/new-website/world_map_nav.png), which is a 1500x1500 square.
// The <WorldMap> component uses this as its SVG viewBox, so these numbers
// can be used directly with no rescaling.

export type RegionShape =
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number; rotate?: number }
  | { kind: 'path'; d: string };

export interface WorldMapRegion {
  id: string;
  /** Display name shown in the hover/focus label, e.g. "Aquarium Kingdom" */
  name: string;
  /** Small secondary line under the name, e.g. "Football Nation" */
  tagline?: string;
  /** Primary glow / accent color for this region */
  color: string;
  /** Route to navigate to when this region is activated. Update to match real site routes. */
  route: string;
  type: 'central' | 'island';
  /** When true, the region is visible and shows a "Coming Soon" label on hover/focus,
   *  but is inert: click/keyboard activation never navigates. Defaults to false. */
  disabled?: boolean;
  /** Point (in viewBox space) the label/CTA and zoom-on-click animation should target */
  center: { x: number; y: number };
  /** SVG hotspot geometry, hand-traced from the artwork coastlines */
  shape: RegionShape;
}

export const WORLD_MAP_VIEWBOX = { width: 1500, height: 1500 };

// Hand-traced coastline of the central landmass (the Tank-dome continent).
// Traced from the artwork at assets/new-website/world_map_nav.png and
// smoothed through the sampled shoreline points with a Catmull-Rom curve.
const AQUARIUM_CONTINENT_PATH =
  'M745,420 C775.8,426.7 803.3,466.7 830,490 C856.7,513.3 884.2,534.2 905,560 ' +
  'C925.8,585.8 942.8,617.5 955,645 C967.2,672.5 974.2,699.2 978,725 C981.8,750.8 981.8,775.8 978,800 ' +
  'C974.2,824.2 965.5,848.7 955,870 C944.5,891.3 931.7,910.5 915,928 C898.3,945.5 878.3,962.7 855,975 ' +
  'C831.7,987.3 801.7,996.5 775,1002 C748.3,1007.5 721.7,1009.7 695,1008 C668.3,1006.3 640.8,1001.3 615,992 ' +
  'C589.2,982.7 560.8,967.7 540,952 C519.2,936.3 504.2,918.0 490,898 C475.8,878.0 462.5,854.7 455,832 ' +
  'C447.5,809.3 446.7,784.8 445,762 C443.3,739.2 442.2,717.8 445,695 C447.8,672.2 453.7,647.8 462,625 ' +
  'C470.3,602.2 480.3,579.2 495,558 C509.7,536.8 525.0,516.0 550,498 C575.0,480.0 612.5,463.0 645,450 ' +
  'C677.5,437.0 714.2,413.3 745,420 Z';

// Hand-traced coastline of the golf island (bottom-right).
const GOLF_ISLAND_PATH =
  'M1145,875 C1166.7,876.7 1191.2,891.7 1210,905 C1228.8,918.3 1245.0,935.0 1258,955 ' +
  'C1271.0,975.0 1284.0,1000.8 1288,1025 C1292.0,1049.2 1289.2,1075.8 1282,1100 C1274.8,1124.2 1262.0,1150.0 1245,1170 ' +
  'C1228.0,1190.0 1203.3,1207.5 1180,1220 C1156.7,1232.5 1130.0,1242.5 1105,1245 C1080.0,1247.5 1052.2,1243.3 1030,1235 ' +
  'C1007.8,1226.7 986.2,1211.7 972,1195 C957.8,1178.3 948.7,1156.7 945,1135 C941.3,1113.3 944.2,1087.5 950,1065 ' +
  'C955.8,1042.5 967.0,1021.2 980,1000 C993.0,978.8 1011.3,955.5 1028,938 C1044.7,920.5 1060.5,905.5 1080,895 ' +
  'C1099.5,884.5 1123.3,873.3 1145,875 Z';

export const WORLD_MAP_REGIONS: WorldMapRegion[] = [
  {
    id: 'aquarium',
    name: 'Aquarium Kingdom',
    tagline: 'Enter World',
    color: '#39d9ff',
    route: '/',
    type: 'central',
    // Zoom/glow target is the aquarium building itself; the hotspot below covers
    // the whole landmass so the label point can differ from the shape's centroid.
    center: { x: 745, y: 730 },
    shape: { kind: 'path', d: AQUARIUM_CONTINENT_PATH },
  },
  {
    id: 'football',
    name: 'Football Island',
    color: '#a855f7',
    route: '/nfl',
    type: 'island',
    center: { x: 760, y: 300 },
    shape: { kind: 'ellipse', cx: 760, cy: 300, rx: 205, ry: 140, rotate: 0 },
  },
  {
    id: 'soccer',
    name: 'Soccer Island',
    color: '#84cc16',
    route: '/soccer',
    type: 'island',
    center: { x: 405, y: 500 },
    shape: { kind: 'circle', cx: 405, cy: 500, r: 185 },
  },
  {
    // The flaming bat is the map's single MLB region: the old art's separate
    // baseball-diamond island doesn't exist in the redesign, so the bat island
    // inherited the plain Baseball identity (name + /mlb route).
    id: 'baseball',
    name: 'Baseball Island',
    color: '#f97316',
    route: '/mlb',
    type: 'island',
    center: { x: 1050, y: 418 },
    shape: { kind: 'ellipse', cx: 1050, cy: 418, rx: 192, ry: 80, rotate: -54 },
  },
  {
    id: 'basketball',
    name: 'Basketball Island',
    color: '#f59e0b',
    route: '/nba',
    type: 'island',
    center: { x: 1190, y: 700 },
    shape: { kind: 'circle', cx: 1190, cy: 700, r: 165 },
  },
  {
    id: 'hockey',
    name: 'Hockey Island',
    color: '#38bdf8',
    route: '/nhl',
    type: 'island',
    center: { x: 675, y: 1175 },
    shape: { kind: 'ellipse', cx: 675, cy: 1175, rx: 190, ry: 135, rotate: -3 },
  },
  {
    id: 'golf',
    name: 'Golf Island',
    color: '#2dd4bf',
    route: '/golf',
    type: 'island',
    center: { x: 1120, y: 1070 },
    shape: { kind: 'path', d: GOLF_ISLAND_PATH },
  },
];
