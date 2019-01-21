import { WritableBitStream, WritableByteStream } from "@open-flash/stream";
import { Incident } from "incident";
import { Uint16, Uint2, Uint8, UintSize } from "semantic-types";
import {
  CapStyle, ColorStop,
  FillStyle,
  fillStyles,
  FillStyleType,
  Glyph,
  JoinStyleType,
  LineStyle,
  Matrix,
  Shape,
  ShapeRecord,
  shapeRecords,
  ShapeRecordType,
} from "swf-tree";
import { getSintMinBitCount, getUintBitCount } from "../get-bit-count";
import { emitMatrix, emitSRgb8, emitStraightSRgba8 } from "./basic-data-types";
import { emitGradient } from "./gradient";

export enum ShapeVersion {
  Shape1 = 1,
  Shape2 = 2,
  Shape3 = 3,
  Shape4 = 4,
}

export function emitGlyph(byteStream: WritableByteStream, value: Glyph): void {
  const bitStream: WritableBitStream = byteStream.asBitStream();
  emitGlyphBits(bitStream, value);
  bitStream.align();
}

export function emitGlyphBits(bitStream: WritableBitStream, value: Glyph): void {
  // TODO: We use the maximum at the moment, but we should check how to determine the bit count
  const fillBits: UintSize = 0b1111;
  const lineBits: UintSize = 0b1111;
  bitStream.writeUint32Bits(4, fillBits);
  bitStream.writeUint32Bits(4, lineBits);
  // TODO: Check which shape version to use
  emitShapeRecordStringBits(bitStream, value.records, fillBits, lineBits, ShapeVersion.Shape1);
}

export function emitShape(byteStream: WritableByteStream, value: Shape, shapeVersion: ShapeVersion): void {
  const bitStream: WritableBitStream = byteStream.asBitStream();
  emitShapeBits(bitStream, value, shapeVersion);
  bitStream.align();
}

export function emitShapeBits(bitStream: WritableBitStream, value: Shape, shapeVersion: ShapeVersion): void {
  let fillBits: UintSize;
  let lineBits: UintSize;
  [fillBits, lineBits] = emitShapeStylesBits(bitStream, value.initialStyles, shapeVersion);
  emitShapeRecordStringBits(bitStream, value.records, fillBits, lineBits, shapeVersion);
}

export interface ShapeStyles {
  fill: FillStyle[];
  line: LineStyle[];
}

/**
 *
 * @param bitStream
 * @param value
 * @param shapeVersion
 * @return [fillBits, lineBits]
 */
export function emitShapeStylesBits(
  bitStream: WritableBitStream,
  value: ShapeStyles,
  shapeVersion: ShapeVersion,
): [UintSize, UintSize] {
  const byteStream: WritableByteStream = bitStream.asByteStream();
  emitFillStyleList(byteStream, value.fill, shapeVersion);
  emitLineStyleList(byteStream, value.line, shapeVersion);
  const fillBits: UintSize = getUintBitCount(value.fill.length + 1); // `+ 1` because of empty style
  const lineBits: UintSize = getUintBitCount(value.line.length + 1); // `+ 1` because of empty style
  bitStream.writeUint32Bits(4, fillBits);
  bitStream.writeUint32Bits(4, lineBits);
  return [fillBits, lineBits];
}

export function emitShapeRecordStringBits(
  bitStream: WritableBitStream,
  value: ShapeRecord[],
  fillBits: UintSize,
  lineBits: UintSize,
  shapeVersion: ShapeVersion,
): void {
  for (const record of value) {
    switch (record.type) {
      case ShapeRecordType.CurvedEdge:
        bitStream.writeBoolBits(true); // isEdge
        bitStream.writeBoolBits(false); // isStraight
        emitCurvedEdgeBits(bitStream, record);
        break;
      case ShapeRecordType.StraightEdge:
        bitStream.writeBoolBits(true); // isEdge
        bitStream.writeBoolBits(true); // isStraight
        emitStraightEdgeBits(bitStream, record);
        break;
      case ShapeRecordType.StyleChange:
        bitStream.writeBoolBits(false); // isEdge
        [fillBits, lineBits] = emitStyleChangeBits(bitStream, record, fillBits, lineBits, shapeVersion);
        break;
      default:
        throw new Incident("UnexpectedShapeRecordType");
    }
  }
  bitStream.writeUint16Bits(6, 0);
}

export function emitCurvedEdgeBits(bitStream: WritableBitStream, value: shapeRecords.CurvedEdge): void {
  const valuesBitCount: UintSize = getSintMinBitCount(
    value.controlDelta.x,
    value.controlDelta.y,
    value.anchorDelta.x,
    value.anchorDelta.y,
  );
  const bitCount: UintSize = Math.max(0, valuesBitCount - 2) + 2;
  bitStream.writeUint16Bits(4, bitCount - 2);
  bitStream.writeSint32Bits(bitCount, value.controlDelta.x);
  bitStream.writeSint32Bits(bitCount, value.controlDelta.y);
  bitStream.writeSint32Bits(bitCount, value.anchorDelta.x);
  bitStream.writeSint32Bits(bitCount, value.anchorDelta.y);
}

export function emitStraightEdgeBits(bitStream: WritableBitStream, value: shapeRecords.StraightEdge): void {
  const bitCount: UintSize = Math.max(0, getSintMinBitCount(value.delta.x, value.delta.y) - 2) + 2;
  bitStream.writeUint16Bits(4, bitCount - 2);
  const isDiagonal: boolean = value.delta.x !== 0 && value.delta.y !== 0;
  bitStream.writeBoolBits(isDiagonal);
  if (isDiagonal) {
    bitStream.writeSint32Bits(bitCount, value.delta.x);
    bitStream.writeSint32Bits(bitCount, value.delta.y);
  } else {
    const isVertical: boolean = value.delta.x === 0;
    bitStream.writeBoolBits(isVertical);
    if (isVertical) {
      bitStream.writeSint32Bits(bitCount, value.delta.y);
    } else {
      bitStream.writeSint32Bits(bitCount, value.delta.x);
    }
  }
}

export function emitStyleChangeBits(
  bitStream: WritableBitStream,
  value: shapeRecords.StyleChange,
  fillBits: UintSize,
  lineBits: UintSize,
  shapeVersion: ShapeVersion,
): [UintSize, UintSize] {
  const hasNewStyles: boolean = value.newStyles !== undefined;
  const changeLineStyle: boolean = value.lineStyle !== undefined;
  const changeRightFill: boolean = value.rightFill !== undefined;
  const changeLeftFill: boolean = value.leftFill !== undefined;
  const hasMoveTo: boolean = value.moveTo !== undefined;

  bitStream.writeBoolBits(hasNewStyles);
  bitStream.writeBoolBits(changeLineStyle);
  bitStream.writeBoolBits(changeRightFill);
  bitStream.writeBoolBits(changeLeftFill);
  bitStream.writeBoolBits(hasMoveTo);

  if (hasMoveTo) {
    const bitCount: UintSize = getSintMinBitCount(value.moveTo!.x, value.moveTo!.y);
    bitStream.writeUint16Bits(5, bitCount);
    bitStream.writeSint32Bits(bitCount, value.moveTo!.x);
    bitStream.writeSint32Bits(bitCount, value.moveTo!.y);
  }

  if (changeLeftFill) {
    bitStream.writeUint16Bits(fillBits, value.leftFill!);
  }
  if (changeRightFill) {
    bitStream.writeUint16Bits(fillBits, value.rightFill!);
  }
  if (changeLineStyle) {
    bitStream.writeUint16Bits(lineBits, value.lineStyle!);
  }

  if (hasNewStyles) {
    [fillBits, lineBits] = emitShapeStylesBits(bitStream, value.newStyles!, shapeVersion);
  }

  return [fillBits, lineBits];
}

export function emitListLength(byteStream: WritableByteStream, value: UintSize, supportExtended: boolean): void {
  if (value < 0xff || (value === 0xff && !supportExtended)) {
    byteStream.writeUint8(value);
  } else {
    byteStream.writeUint8(0xff);
    byteStream.writeUint16LE(value);
  }
}

export function emitFillStyleList(
  byteStream: WritableByteStream,
  value: FillStyle[],
  shapeVersion: ShapeVersion,
): void {
  emitListLength(byteStream, value.length, shapeVersion >= ShapeVersion.Shape2);
  for (const fillStyle of value) {
    emitFillStyle(byteStream, fillStyle, shapeVersion >= ShapeVersion.Shape3);
  }
}

export function emitFillStyle(byteStream: WritableByteStream, value: FillStyle, withAlpha: boolean): void {
  switch (value.type) {
    case FillStyleType.Bitmap:
      const code: Uint8 = 0
        | (!value.repeating ? 1 << 0 : 0)
        | (!value.smoothed ? 1 << 1 : 0)
        | 0x40;
      byteStream.writeUint8(code);
      emitBitmapFill(byteStream, value);
      break;
    case FillStyleType.FocalGradient:
      byteStream.writeUint8(0x13);
      emitFocalGradientFill(byteStream, value, withAlpha);
      break;
    case FillStyleType.LinearGradient:
      byteStream.writeUint8(0x10);
      emitLinearGradientFill(byteStream, value, withAlpha);
      break;
    case FillStyleType.RadialGradient:
      byteStream.writeUint8(0x12);
      emitRadialGradientFill(byteStream, value, withAlpha);
      break;
    case FillStyleType.Solid:
      byteStream.writeUint8(0x00);
      emitSolidFill(byteStream, value, withAlpha);
      break;
    default:
      throw new Incident("UnexpectedFillStyle");
  }
}

export function emitBitmapFill(byteStream: WritableByteStream, value: { bitmapId: Uint16; matrix: Matrix }): void {
  byteStream.writeUint16LE(value.bitmapId);
  emitMatrix(byteStream, value.matrix);
}

export function emitFocalGradientFill(
  byteStream: WritableByteStream,
  value: fillStyles.FocalGradient,
  withAlpha: boolean,
): void {
  emitMatrix(byteStream, value.matrix);
  emitGradient(byteStream, value.gradient, withAlpha);
  byteStream.writeSint16LE(value.focalPoint.epsilons);
}

export function emitLinearGradientFill(
  byteStream: WritableByteStream,
  value: fillStyles.LinearGradient,
  withAlpha: boolean,
): void {
  emitMatrix(byteStream, value.matrix);
  emitGradient(byteStream, value.gradient, withAlpha);
}

export function emitRadialGradientFill(
  byteStream: WritableByteStream,
  value: fillStyles.RadialGradient,
  withAlpha: boolean,
): void {
  emitMatrix(byteStream, value.matrix);
  emitGradient(byteStream, value.gradient, withAlpha);
}

export function emitSolidFill(byteStream: WritableByteStream, value: fillStyles.Solid, withAlpha: boolean): void {
  if (withAlpha) {
    emitStraightSRgba8(byteStream, value.color);
  } else {
    emitSRgb8(byteStream, value.color);
  }
}

export function emitLineStyleList(
  byteStream: WritableByteStream,
  value: LineStyle[],
  shapeVersion: ShapeVersion,
): void {
  emitListLength(byteStream, value.length, shapeVersion >= ShapeVersion.Shape2);
  for (const lineStyle of value) {
    if (shapeVersion < ShapeVersion.Shape4) {
      emitLineStyle1(byteStream, lineStyle, shapeVersion >= ShapeVersion.Shape3);
    } else {
      emitLineStyle2(byteStream, lineStyle);
    }
  }
}

export function emitLineStyle1(byteStream: WritableByteStream, value: LineStyle, withAlpha: boolean): void {
  if (value.fill.type !== FillStyleType.Solid) {
    throw new Incident("ExpectedSolidFill");
  }
  byteStream.writeUint16LE(value.width);
  if (withAlpha) {
    emitStraightSRgba8(byteStream, value.fill.color);
  } else {
    emitSRgb8(byteStream, value.fill.color);
  }
}

export function emitLineStyle2(byteStream: WritableByteStream, value: LineStyle): void {
  byteStream.writeUint16LE(value.width);

  const hasFill: boolean = value.fill.type !== FillStyleType.Solid;
  const joinStyleCode: Uint2 = getJoinStyleCode(value.join.type);
  const startCapStyleCode: Uint2 = getCapStyleCode(value.startCap);
  const endCapStyleCode: Uint2 = getCapStyleCode(value.endCap);

  const flags: Uint16 = 0
    | (value.pixelHinting ? 1 << 0 : 0)
    | (value.noVScale ? 1 << 1 : 0)
    | (value.noHScale ? 1 << 2 : 0)
    | (hasFill ? 1 << 3 : 0)
    | ((joinStyleCode & 0b11) << 4)
    | ((startCapStyleCode & 0b11) << 6)
    | ((endCapStyleCode & 0b11) << 8)
    | (value.noClose ? 1 << 10 : 0);
  byteStream.writeUint16LE(flags);

  if (value.join.type === JoinStyleType.Miter) {
    byteStream.writeSint16LE(value.join.limit.epsilons);
  }

  if (hasFill) {
    emitFillStyle(byteStream, value.fill, true);
  } else {
    emitStraightSRgba8(byteStream, (value.fill as fillStyles.Solid).color);
  }
}

export function getCapStyleCode(capStyle: CapStyle): Uint2 {
  switch (capStyle) {
    case CapStyle.None:
      return 1 as Uint2;
    case CapStyle.Round:
      return 0 as Uint2;
    case CapStyle.Square:
      return 2 as Uint2;
    default:
      throw new Incident("UnexpectedCapStyle");
  }
}

export function getJoinStyleCode(joinStyleType: JoinStyleType): Uint2 {
  switch (joinStyleType) {
    case JoinStyleType.Bevel:
      return 1 as Uint2;
    case JoinStyleType.Round:
      return 0 as Uint2;
    case JoinStyleType.Miter:
      return 2 as Uint2;
    default:
      throw new Incident("UnexpectedJoinStyleType");
  }
}

function isLineStyle2(style: LineStyle): boolean {
  // Check if one of the values is different than the default used for lineStyle1
  return style.startCap !== CapStyle.Round
    || style.endCap !== CapStyle.Round
    || style.join.type !== JoinStyleType.Round
    || style.noHScale
    || style.noVScale
    || style.noClose
    || style.pixelHinting
    || style.fill.type !== FillStyleType.Solid;
}

function getLineStyleMinShapeVersion(style: LineStyle): ShapeVersion {
  if (isLineStyle2(style)) {
    return ShapeVersion.Shape4;
  } else if ((style.fill as fillStyles.Solid).color.a !== 0xff) {
    return ShapeVersion.Shape3;
  } else {
    return ShapeVersion.Shape1;
  }
}

function getFillStyleMinShapeVersion(style: FillStyle): ShapeVersion {
  // Check if alpha channel is used
  switch (style.type) {
    case FillStyleType.Solid:
      if (style.color.a !== 0xff) {
        return ShapeVersion.Shape3;
      }
      break;
    case FillStyleType.LinearGradient:
    case FillStyleType.RadialGradient:
    case FillStyleType.FocalGradient:
      if (style.gradient.colors.some((cs: ColorStop): boolean => cs.color.a !== 0xff)) {
        return ShapeVersion.Shape3;
      }
      break;
    default:
      // Bitmap
      break;
  }
  return ShapeVersion.Shape1;
}

function getFillStyleListMinShapeVersion(styles: FillStyle[]): ShapeVersion {
  let minVersion: ShapeVersion = styles.length < 0xff ? ShapeVersion.Shape1 : ShapeVersion.Shape2;
  for (const style of styles) {
    const styleMinVersion: ShapeVersion = getFillStyleMinShapeVersion(style);
    if (styleMinVersion > minVersion) {
      minVersion = styleMinVersion;
    }
  }
  return minVersion;
}

function getLineStyleListMinShapeVersion(styles: LineStyle[]): ShapeVersion {
  let minVersion: ShapeVersion = styles.length < 0xff ? ShapeVersion.Shape1 : ShapeVersion.Shape2;
  for (const style of styles) {
    const styleMinVersion: ShapeVersion = getLineStyleMinShapeVersion(style);
    if (styleMinVersion > minVersion) {
      minVersion = styleMinVersion;
    }
  }
  return minVersion;
}

function getShapeStylesMinShapeVersion(shapeStyles: ShapeStyles): ShapeVersion {
  let minVersion: ShapeVersion = ShapeVersion.Shape1;
  {
    const fillStylesMinVersion: ShapeVersion = getFillStyleListMinShapeVersion(shapeStyles.fill);
    if (fillStylesMinVersion > minVersion) {
      minVersion = fillStylesMinVersion;
    }
  }
  {
    const lineStylesMinVersion: ShapeVersion = getLineStyleListMinShapeVersion(shapeStyles.line);
    if (lineStylesMinVersion > minVersion) {
      minVersion = lineStylesMinVersion;
    }
  }
  return minVersion;
}

export function getMinShapeVersion(shape: Shape): ShapeVersion {
  let minVersion: ShapeVersion = getShapeStylesMinShapeVersion(shape.initialStyles);
  for (const record of shape.records) {
    if (record.type === ShapeRecordType.StyleChange && record.newStyles !== undefined) {
      const stylesMinVersion: ShapeVersion = getShapeStylesMinShapeVersion(record.newStyles);
      if (stylesMinVersion > minVersion) {
        minVersion = stylesMinVersion;
      }
    }
  }
  return minVersion;
}
