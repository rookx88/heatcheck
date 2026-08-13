// Configuration + geometry for the HeatCheck flash-navigation world map.
// Coordinates are in the SAME pixel space as the source artwork
// (assets/new-website/HeatChecksWorldMap.svg), which is a 1254x1254 square.
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

export const WORLD_MAP_VIEWBOX = { width: 1254, height: 1254 };

// Hand-traced coastline of the central landmass (the aquarium continent).
// Traced from the artwork at assets/new-website/HeatChecksWorldMap.svg and
// smoothed through the sampled shoreline points with a Catmull-Rom curve.
const AQUARIUM_CONTINENT_PATH =
  'M600.0,285.0 C613.3,282.5 624.2,305.8 635.0,320.0 C645.8,334.2 652.5,357.5 665.0,370.0 ' +
  'C677.5,382.5 697.5,385.0 710.0,395.0 C722.5,405.0 730.8,418.3 740.0,430.0 C749.2,441.7 763.3,454.2 765.0,465.0 ' +
  'C766.7,475.8 747.5,485.0 750.0,495.0 C752.5,505.0 771.7,514.2 780.0,525.0 C788.3,535.8 792.5,549.2 800.0,560.0 ' +
  'C807.5,570.8 816.7,580.0 825.0,590.0 C833.3,600.0 843.3,613.3 850.0,620.0 C856.7,626.7 865.0,621.7 865.0,630.0 ' +
  'C865.0,638.3 850.0,657.5 850.0,670.0 C850.0,682.5 858.3,695.8 865.0,705.0 C871.7,714.2 882.5,715.8 890.0,725.0 ' +
  'C897.5,734.2 903.3,750.8 910.0,760.0 C916.7,769.2 931.7,771.7 930.0,780.0 C928.3,788.3 901.7,800.0 900.0,810.0 ' +
  'C898.3,820.0 922.5,830.0 920.0,840.0 C917.5,850.0 895.0,860.0 885.0,870.0 C875.0,880.0 867.5,890.0 860.0,900.0 ' +
  'C852.5,910.0 846.7,920.0 840.0,930.0 C833.3,940.0 835.0,953.3 820.0,960.0 C805.0,966.7 778.3,967.5 750.0,970.0 ' +
  'C721.7,972.5 681.7,975.0 650.0,975.0 C618.3,975.0 584.2,972.5 560.0,970.0 C535.8,967.5 518.3,965.8 505.0,960.0 ' +
  'C491.7,954.2 490.0,943.3 480.0,935.0 C470.0,926.7 450.0,921.7 445.0,910.0 C440.0,898.3 457.5,876.7 450.0,865.0 ' +
  'C442.5,853.3 405.8,850.8 400.0,840.0 C394.2,829.2 417.5,813.3 415.0,800.0 C412.5,786.7 385.8,773.3 385.0,760.0 ' +
  'C384.2,746.7 412.5,734.2 410.0,720.0 C407.5,705.8 371.7,686.7 370.0,675.0 C368.3,663.3 389.2,657.5 400.0,650.0 ' +
  'C410.8,642.5 427.5,637.5 435.0,630.0 C442.5,622.5 441.7,614.2 445.0,605.0 C448.3,595.8 450.8,584.2 455.0,575.0 ' +
  'C459.2,565.8 464.2,559.2 470.0,550.0 C475.8,540.8 488.3,529.2 490.0,520.0 C491.7,510.8 478.3,502.5 480.0,495.0 ' +
  'C481.7,487.5 493.3,484.2 500.0,475.0 C506.7,465.8 519.2,450.8 520.0,440.0 C520.8,429.2 504.2,421.7 505.0,410.0 ' +
  'C505.8,398.3 516.7,382.5 525.0,370.0 C533.3,357.5 542.5,349.2 555.0,335.0 C567.5,320.8 586.7,287.5 600.0,285.0 Z';

// Hand-traced coastline of the golf island (bottom-right).
const GOLF_ISLAND_PATH =
  'M915.0,825.0 C927.0,822.8 961.2,812.0 980.0,815.0 C998.8,818.0 1023.5,833.8 1040.0,845.0 ' +
  'C1056.5,856.2 1078.8,874.2 1090.0,890.0 C1101.2,905.8 1112.0,932.0 1115.0,950.0 C1118.0,968.0 1115.2,993.5 1110.0,1010.0 ' +
  'C1104.8,1026.5 1092.8,1046.5 1080.0,1060.0 C1067.2,1073.5 1043.0,1091.8 1025.0,1100.0 C1007.0,1108.2 978.8,1115.0 960.0,1115.0 ' +
  'C941.2,1115.0 916.5,1106.0 900.0,1100.0 C883.5,1094.0 863.5,1084.0 850.0,1075.0 C836.5,1066.0 819.0,1052.8 810.0,1040.0 ' +
  'C801.0,1027.2 790.0,1003.5 790.0,990.0 C790.0,976.5 804.0,962.0 810.0,950.0 C816.0,938.0 823.2,920.5 830.0,910.0 ' +
  'C836.8,899.5 848.2,889.0 855.0,880.0 C861.8,871.0 868.2,857.5 875.0,850.0 C881.8,842.5 894.0,833.8 900.0,830.0 ' +
  'C906.0,826.2 903.0,827.2 915.0,825.0 Z';

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
    center: { x: 620, y: 630 },
    shape: { kind: 'path', d: AQUARIUM_CONTINENT_PATH },
  },
  {
    id: 'football',
    name: 'Football Island',
    color: '#a855f7',
    route: '/nfl',
    type: 'island',
    center: { x: 615, y: 206 },
    shape: { kind: 'ellipse', cx: 615, cy: 206, rx: 205, ry: 120, rotate: 4 },
  },
  {
    id: 'soccer',
    name: 'Soccer Island',
    color: '#84cc16',
    route: '/soccer',
    type: 'island',
    center: { x: 280, y: 420 },
    shape: { kind: 'circle', cx: 280, cy: 420, r: 175 },
  },
  {
    id: 'baseballBat',
    name: 'Baseball Bat Island',
    color: '#f97316',
    route: '/mlb-bat',
    type: 'island',
    center: { x: 870, y: 342 },
    shape: { kind: 'ellipse', cx: 870, cy: 342, rx: 160, ry: 65, rotate: -57.9 },
  },
  {
    id: 'basketball',
    name: 'Basketball Island',
    color: '#f59e0b',
    route: '/nba',
    type: 'island',
    center: { x: 1015, y: 615 },
    shape: { kind: 'circle', cx: 1015, cy: 615, r: 155 },
  },
  {
    id: 'baseball',
    name: 'Baseball Island',
    color: '#ef4444',
    route: '/mlb',
    type: 'island',
    center: { x: 260, y: 875 },
    shape: { kind: 'circle', cx: 260, cy: 875, r: 165 },
  },
  {
    id: 'hockey',
    name: 'Hockey Island',
    color: '#38bdf8',
    route: '/nhl',
    type: 'island',
    center: { x: 540, y: 1080 },
    shape: { kind: 'ellipse', cx: 540, cy: 1080, rx: 165, ry: 100, rotate: -3 },
  },
  {
    id: 'golf',
    name: 'Golf Island',
    color: '#2dd4bf',
    route: '/golf',
    type: 'island',
    center: { x: 940, y: 957 },
    shape: { kind: 'path', d: GOLF_ISLAND_PATH },
  },
];
