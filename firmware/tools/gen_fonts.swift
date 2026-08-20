// gen_fonts.swift —— 在 macOS 上运行（无需 Xcode 工程）：
//   swift firmware/tools/gen_fonts.swift
// 用 CoreText 把状态页所需汉字/ASCII 渲染成 1bpp 点阵 C 数组，供固件 lib/EchoPaper 绘制。
// 汉字 24×24（PingFang SC，3 字节/行），ASCII 8×16（Menlo，1 字节/行）。
// 按墨迹包围盒居中放入字格；墨迹超格时钳位裁剪（括号类高字符会削顶/底，可接受）。

import Foundation
import CoreText
import CoreGraphics

let outDir = "lib/EchoPaper"  // 从 firmware/ 目录运行

// ---- 所有会上屏的字符串（新增文案后在此追加并重新生成）----
let CN_SIZE = 20  // 中文字号（宽=高）；行字节数 = (CN_SIZE+7)/8

let cnLabels = [
    "待机", "监听中", "录音中", "第段", "已暂停", "长按恢复",
    "同步", "电脑已连接", "正在同步", "充电中", "低电", "请充电",
    "秒后自动关机", "今日条", "已关机", "按键重新开机",
    "短按切换状态", "电量不足", "时间未校准",
    "设备异常",
]

// ---- 渲染单个字符的灰度墨迹（canvas = size + 20，基线放低防裁 ascender/descender）----
func renderInk(_ ch: Character, fontName: CFString, size: Int) -> [UInt8] {
    let canvas = size * 2
    var buf = [UInt8](repeating: 255, count: canvas * canvas)
    let cs = CGColorSpaceCreateDeviceGray()
    let ctx = CGContext(data: &buf, width: canvas, height: canvas, bitsPerComponent: 8,
                        bytesPerRow: canvas, space: cs,
                        bitmapInfo: CGImageAlphaInfo.none.rawValue)!
    let font = CTFontCreateWithName(fontName, CGFloat(size), nil)
    let attr = NSAttributedString(string: String(ch), attributes: [
        NSAttributedString.Key(kCTFontAttributeName as String as String): font,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String as String): CGColor(gray: 0.0, alpha: 1.0),
    ])
    let line = CTLineCreateWithAttributedString(attr)
    ctx.setFillColor(CGColor(gray: 1.0, alpha: 1.0))
    ctx.fill(CGRect(x: 0, y: 0, width: canvas, height: canvas))
    // 基线放在距底 1.25×size：CJK 字墨最高 ~0.88×size，顶部余量充足不再被裁
    ctx.textPosition = CGPoint(x: 4, y: CGFloat(size) * 1.25)
    CTLineDraw(line, ctx)
    return buf
}

// ---- 墨迹裁剪并居中进 w×h 字格；nil = 空白字符 ----
func cropTo(_ buf: [UInt8], canvas: Int, w: Int, h: Int) -> [Bool]? {
    var minX = canvas, minY = canvas, maxX = -1, maxY = -1
    for y in 0..<canvas {
        for x in 0..<canvas where buf[y * canvas + x] < 128 {
            if x < minX { minX = x }; if x > maxX { maxX = x }
            if y < minY { minY = y }; if y > maxY { maxY = y }
        }
    }
    guard maxX >= 0 else { return nil }
    var grid = Array(repeating: false, count: w * h)
    let iw = maxX - minX + 1, ih = maxY - minY + 1
    let offX = max(0, (w - iw) / 2), offY = max(0, (h - ih) / 2)
    for dy in 0..<ih {
        let gy = offY + dy
        if gy >= h { break }
        for dx in 0..<iw {
            let gx = offX + dx
            if gx >= w { break }
            grid[gy * w + gx] = buf[(minY + dy) * canvas + (minX + dx)] < 128
        }
    }
    return grid
}

func packBits(_ grid: [Bool], w: Int, h: Int, bytesPerRow: Int) -> [UInt8] {
    var out = [UInt8](repeating: 0, count: bytesPerRow * h)
    for y in 0..<h {
        for x in 0..<w where grid[y * w + x] {
            out[y * bytesPerRow + x / 8] |= 0x80 >> (x % 8)
        }
    }
    return out
}

func asciiArt(_ grid: [Bool], w: Int, h: Int) -> String {
    (0..<h).map { y in
        (0..<w).map { x in grid[y * w + x] ? "#" : "." }.joined()
    }.joined(separator: "\n")
}

// ---- 生成汉字 ----
var cnChars = Set<Character>()
for s in cnLabels {
    for ch in s where ch.unicodeScalars.first!.value > 0x7F { cnChars.insert(ch) }
}
let sortedCN = cnChars.sorted { $0.unicodeScalars.first!.value < $1.unicodeScalars.first!.value }
print("汉字数: \(sortedCN.count) -> \(String(sortedCN))")

var cnData = ""
var cnIndex = ""  // UTF-32 码点索引
for ch in sortedCN {
    let buf = renderInk(ch, fontName: "PingFangSC-Regular" as CFString, size: CN_SIZE)
    guard let grid = cropTo(buf, canvas: CN_SIZE * 2, w: CN_SIZE, h: CN_SIZE) else {
        print("!! 汉字无墨迹: \(ch)"); exit(1)
    }
    let bytes = packBits(grid, w: CN_SIZE, h: CN_SIZE, bytesPerRow: (CN_SIZE + 7) / 8)
    cnData += "    {" + bytes.map { String(format: "0x%02X", $0) }.joined(separator: ",") + "},\n"
    cnIndex += String(format: "    0x%06X,", ch.unicodeScalars.first!.value) + " // \(ch)\n"
    if ch == "待" || ch == "录" { print("预览[\(ch)]:\n" + asciiArt(grid, w: CN_SIZE, h: CN_SIZE) + "\n") }
}

let cnH = """
#ifndef FONT_CN\(CN_SIZE)_H_GUARD
#define FONT_CN\(CN_SIZE)_H_GUARD
// 自动生成：swift firmware/tools/gen_fonts.swift —— 勿手改
// \(CN_SIZE)×\(CN_SIZE) 1bpp 点阵（行主序 MSB 在前，1=着色），3 字节/行，UTF-32 码点索引
#include <stdint.h>
#define FONT_CN\(CN_SIZE)_SIZE \(CN_SIZE)
#define FONT_CN\(CN_SIZE)_BYTES \((CN_SIZE + 7) / 8 * CN_SIZE)
#define FONT_CN\(CN_SIZE)_COUNT \(sortedCN.count)
extern const uint32_t FontCN\(CN_SIZE)_Index[FONT_CN\(CN_SIZE)_COUNT];
extern const uint8_t FontCN\(CN_SIZE)_Data[FONT_CN\(CN_SIZE)_COUNT][FONT_CN\(CN_SIZE)_BYTES];
#endif
"""
let cnCpp = """
#include "font_cn\(CN_SIZE).h"
// 自动生成：swift firmware/tools/gen_fonts.swift —— 勿手改
const uint32_t FontCN\(CN_SIZE)_Index[FONT_CN\(CN_SIZE)_COUNT] = {
\(cnIndex)};
const uint8_t FontCN\(CN_SIZE)_Data[FONT_CN\(CN_SIZE)_COUNT][FONT_CN\(CN_SIZE)_BYTES] = {
\(cnData)};
"""

// ---- 生成 ASCII 8×16（可打印区 0x20-0x7E）----
var ascRows: [String] = []
var first = true
for cp in 0x20...0x7E {
    let ch = Character(UnicodeScalar(cp)!)
    let buf = renderInk(ch, fontName: "Menlo-Regular" as CFString, size: 16)
    let grid = cropTo(buf, canvas: 32, w: 8, h: 16) ?? Array(repeating: false, count: 8 * 16)
    if cp == 0x38 { print("预览[8]:\n" + asciiArt(grid, w: 8, h: 16) + "\n") }
    let bytes = packBits(grid, w: 8, h: 16, bytesPerRow: 1)
    ascRows.append("    {" + bytes.map { String(format: "0x%02X", $0) }.joined(separator: ",") + "}")
    _ = first; first = false
}
let ascH = """
#ifndef FONT_ASCII16_H_GUARD
#define FONT_ASCII16_H_GUARD
#include <stdint.h>
// 自动生成：swift firmware/tools/gen_fonts.swift —— 勿手改
// 8×16 1bpp 点阵（1 字节/行 × 16 行），索引 = 字符 - 0x20
#define FONT_ASCII16_W 8
#define FONT_ASCII16_H 16
#define FONT_ASCII16_COUNT 95
extern const uint8_t FontASCII16_Data[FONT_ASCII16_COUNT][FONT_ASCII16_H];
#endif
"""
let ascCpp = """
#include "font_ascii16.h"
// 自动生成：swift firmware/tools/gen_fonts.swift —— 勿手改
const uint8_t FontASCII16_Data[FONT_ASCII16_COUNT][FONT_ASCII16_H] = {
\(ascRows.joined(separator: ",\n"))
};
"""

try! FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
try! cnH.write(toFile: outDir + "/font_cn\(CN_SIZE).h", atomically: true, encoding: .utf8)
try! cnCpp.write(toFile: outDir + "/font_cn\(CN_SIZE).cpp", atomically: true, encoding: .utf8)
try! ascH.write(toFile: outDir + "/font_ascii16.h", atomically: true, encoding: .utf8)
try! ascCpp.write(toFile: outDir + "/font_ascii16.cpp", atomically: true, encoding: .utf8)
print("已生成: font_cn\(CN_SIZE)(\(sortedCN.count)字) font_ascii16(95字) -> \(outDir)")
