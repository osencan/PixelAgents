import { useEffect, useMemo, useRef } from 'react';

import { OFFICE_THUMB_TILE_PX, WALL_COLOR } from '../../constants.js';
import { getColorizedFloorSprite, hasFloorSprites } from '../floorTiles.js';
import { getCatalogEntry } from '../layout/furnitureCatalog.js';
import type { OfficePreset } from '../layout/offices.js';
import { officeIdOf, OFFICES } from '../layout/offices.js';
import { getCachedSprite } from '../sprites/spriteCache.js';
import type { OfficeLayout } from '../types.js';
import { TILE_SIZE, TileType } from '../types.js';

/** The rows and columns an office occupies: its tiles minus the empty (void) margin. */
function occupiedBounds(layout: OfficeLayout) {
  let minCol = layout.cols;
  let minRow = layout.rows;
  let maxCol = -1;
  let maxRow = -1;
  layout.tiles.forEach((tile, i) => {
    if (tile === TileType.VOID) return;
    const col = i % layout.cols;
    const row = Math.floor(i / layout.cols);
    minCol = Math.min(minCol, col);
    minRow = Math.min(minRow, row);
    maxCol = Math.max(maxCol, col);
    maxRow = Math.max(maxRow, row);
  });
  if (maxCol < 0) return { minCol: 0, minRow: 0, cols: layout.cols, rows: layout.rows };
  return { minCol, minRow, cols: maxCol - minCol + 1, rows: maxRow - minRow + 1 };
}

/** A small picture of an office: floors, walls and furniture, scaled down and cropped. */
function OfficeThumbnail({ layout }: { layout: OfficeLayout }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bounds = useMemo(() => occupiedBounds(layout), [layout]);
  const width = bounds.cols * OFFICE_THUMB_TILE_PX;
  const height = bounds.rows * OFFICE_THUMB_TILE_PX;

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    const px = OFFICE_THUMB_TILE_PX;
    const scale = px / TILE_SIZE;
    ctx.translate(-bounds.minCol * px, -bounds.minRow * px);
    for (let row = 0; row < layout.rows; row++) {
      for (let col = 0; col < layout.cols; col++) {
        const i = row * layout.cols + col;
        const tile = layout.tiles[i];
        if (tile === TileType.VOID) continue;
        if (tile === TileType.WALL || !hasFloorSprites()) {
          ctx.fillStyle = WALL_COLOR;
          ctx.fillRect(col * px, row * px, px, px);
          continue;
        }
        const color = layout.tileColors?.[i] ?? { h: 0, s: 0, b: 0, c: 0 };
        ctx.drawImage(
          getCachedSprite(getColorizedFloorSprite(tile, color), 1),
          col * px,
          row * px,
          px,
          px,
        );
      }
    }
    // Back rows first, so nearer furniture draws over what stands behind it.
    const furniture = [...layout.furniture].sort((a, b) => a.row - b.row);
    for (const item of furniture) {
      const entry = getCatalogEntry(item.type);
      if (!entry) continue;
      const sprite = getCachedSprite(entry.sprite, 1);
      const w = sprite.width * scale;
      const h = sprite.height * scale;
      ctx.drawImage(sprite, item.col * px, (item.row + entry.footprintH) * px - h, w, h);
    }
  }, [layout, bounds, width, height]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{ width, height, display: 'block', imageRendering: 'auto' }}
    />
  );
}

interface OfficePickerProps {
  layout: OfficeLayout;
  onPickOffice: (office: OfficePreset) => void;
}

/** Layout → Offices: the ready-made offices; picking one replaces the floor plan. */
export function OfficePicker({ layout, onPickOffice }: OfficePickerProps) {
  const currentId = useMemo(() => officeIdOf(layout), [layout]);
  return (
    <div className="fade-stagger flex flex-col-reverse gap-4">
      <div className="text-xs text-text-muted px-4">
        Picking an office replaces the floor plan, furniture and rooms. Pets stay. Undo brings yours
        back.
      </div>
      <div className="carousel" data-testid="offices-carousel">
        {OFFICES.map((office) => {
          const current = office.id === currentId;
          return (
            <button
              key={office.id}
              onClick={() => {
                if (!current) onPickOffice(office);
              }}
              title={office.description}
              aria-pressed={current}
              className={`p-4 rounded-none cursor-pointer shrink-0 border-2 flex flex-col items-center justify-end gap-2 bg-bg ${
                current ? 'border-accent' : 'border-transparent'
              }`}
            >
              <OfficeThumbnail layout={office.layout} />
              <span className="text-xs text-text">{office.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
