// File: functions/api_matrix_optimized.js

import { GoogleGenerativeAI } from '@google/generative-ai';

export const config = {
  regions: ["iad", "ewr", "lhr", "fra"]
};

export async function onRequest(context) {
  const { request, env } = context;
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  if (request.method === "POST") {
    try {
      const apiKey = env.GOOGLE_API_KEY;
      if (!apiKey) throw new Error("Thiếu API Key");

      const body = await request.json();
      let { 
          license_key, topics, subject, grade, semester, 
          exam_type, time, use_short_answer, book_series,
          step, previous_html
      } = body;

      // Mặc định step=1 nếu không có
      if (!step) step = 1;

      const timeInt = parseInt(time);

   // ============================================
   // BƯỚC 1: TẠO MA TRẬN + ĐẶC TẢ
   // ============================================
      if (step === 1) {
          // 1. CHECK LICENSE
          if (env.TEST_TOOL && license_key) { 
              const creditStr = await env.TEST_TOOL.get(license_key); 
              if (!creditStr || parseInt(creditStr) <= 0) {
                  return new Response(JSON.stringify({ error: "License hết hạn!" }), { status: 403, headers: corsHeaders });
              }
          }

          // 2. CẤU HÌNH ĐIỂM SỐ & QUOTA
          let scores = { mcq: 0.25, ds: 0.25, tln: 0.5, tl: 1.0 }; 
          let quotas = { mcq: 0, ds: 0, tln: 0, tl: 0 };
          let structureInfo = "";

          if (use_short_answer) {
              if (timeInt >= 60) {
                  scores = { mcq: 0.25, ds: 0.25, tln: 0.5, tl: 1.0 };
                  quotas = { mcq: 12, ds: 8, tln: 4, tl: 3 };
                  structureInfo = "4 Phần: 12 MCQ (3đ), 2 Đ/S (2đ), 4 TLN (2đ), 3 TL (3đ)";
              } else {
                  scores = { mcq: 0.5, ds: 0.25, tln: 0.5, tl: 1.0 }; 
                  quotas = { mcq: 6, ds: 8, tln: 4, tl: 3 }; 
                  structureInfo = "4 Phần: 6 MCQ (3đ), 2 Đ/S (2đ), 4 TLN (2đ), 3 TL (3đ)";
              }
          } else {
              if (timeInt >= 60) {
                  scores = { mcq: 0.25, ds: 0.25, tln: 0, tl: 1.0 };
                  quotas = { mcq: 12, ds: 8, tln: 0, tl: 3 };
                  structureInfo = "2 Phần: 12 MCQ (3đ), 4 Đ/S (4đ), 3 TL (3đ)";
              } else {
                  scores = { mcq: 0.5, ds: 0.25, tln: 0, tl: 1.5 };
                  quotas = { mcq: 6, ds: 8, tln: 0, tl: 2 };
                  structureInfo = "2 Phần: 6 MCQ (3đ), 4 Đ/S (4đ), 2 TL (3đ)";
              }
          }

          // 3. TÍNH ĐIỂM MỤC TIÊU (TARGET SCORE) - LOGIC 25/75
          let units = [];
          let totalP1 = 0;
          let totalP2 = 0;

          topics.forEach(topic => {
              topic.units.forEach(unit => {
                  totalP1 += parseFloat(unit.p1) || 0;
                  totalP2 += parseFloat(unit.p2) || 0;
              });
          });
          if (totalP1 === 0) totalP1 = 1;
          if (totalP2 === 0) totalP2 = 1;

          topics.forEach((topic, tIdx) => {
              topic.units.forEach((unit, uIdx) => {
                  let p1 = parseFloat(unit.p1) || 0;
                  let p2 = parseFloat(unit.p2) || 0;
                  let targetScore = 0;

                  if (exam_type === 'hk') {
                      let scoreFromP1 = (p1 / totalP1) * 2.5; 
                      let scoreFromP2 = (p2 / totalP2) * 7.5;
                      targetScore = scoreFromP1 + scoreFromP2;
                  } else {
                      let totalP = totalP1 + totalP2;
                      targetScore = ((p1 + p2) / totalP) * 10.0;
                  }
                  
                  let weightFromExcel = unit.excel_weight ? parseFloat(unit.excel_weight) : 0;
                  let isImportant = (p2 > 0 && exam_type === 'hk') || weightFromExcel > 5;

                  units.push({
                      id: `U_${tIdx}_${uIdx}`,
                      chapter: topic.name,
                      name: unit.content,
                      isImportant: isImportant,
                      targetScore: targetScore,
                      currentScore: 0, 
                      cells: {
                          mcq: { b: 0, h: 0, vd: 0 },
                          ds:  { b: 0, h: 0, vd: 0 },
                          tln: { b: 0, h: 0, vd: 0 },
                          tl:  { b: 0, h: 0, vd: 0 }
                      }
                  });
              });
          });
    
          // 4. THUẬT TOÁN PHÂN BỔ: HILL CLIMBING
          const TARGETS = { vd: 3.0, h: 3.0, b: 4.0 };
          const EPSILON = 0.001; 
          const MAX_ATTEMPTS = 50;
          const STEPS_PER_CLIMB = 200;

          const createSlots = () => {
              let slots = [];
              const add = (type, count, score, allowed) => {
                  for(let i=0; i<count; i++) slots.push({ type, point: score, allowed, assigned: 'b' });
              };
              if (quotas.tl > 0) add('tl', quotas.tl, scores.tl, ['vd', 'h', 'b']);
              if (quotas.tln > 0) add('tln', quotas.tln, scores.tln, ['vd', 'h', 'b']);
              if (quotas.ds > 0) add('ds', quotas.ds, scores.ds, ['h', 'b']);
              if (quotas.mcq > 0) add('mcq', quotas.mcq, scores.mcq, ['vd', 'h', 'b']);
              return slots;
          };

          const calculateBadness = (slots) => {
              let pts = { vd: 0, h: 0 };
              let types = { vd: new Set(), h: new Set() };
              
              slots.forEach(s => {
                  if (s.assigned === 'vd') { pts.vd += s.point; types.vd.add(s.type); }
                  if (s.assigned === 'h')  { pts.h += s.point;  types.h.add(s.type); }
              });

              let diffVD = Math.abs(TARGETS.vd - pts.vd);
              let diffH = Math.abs(TARGETS.h - pts.h);
              let scoreError = (diffVD + diffH) * 1000; 
              let diversityBonus = (types.vd.size + types.h.size) * 50; 

              return scoreError - diversityBonus;
          };

          const hillClimbingSolve = () => {
              let bestGlobalSolution = null;
              let minGlobalBadness = Infinity;

              for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
                  let currentSlots = createSlots();
                  currentSlots.forEach(s => {
                      let validLevels = s.allowed;
                      s.assigned = validLevels[Math.floor(Math.random() * validLevels.length)];
                  });

                  let currentBadness = calculateBadness(currentSlots);

                  for (let step = 0; step < STEPS_PER_CLIMB; step++) {
                      let nextSlots = currentSlots.map(s => ({...s})); 
                      let randIdx = Math.floor(Math.random() * nextSlots.length);
                      let slot = nextSlots[randIdx];
                      let otherLevels = slot.allowed.filter(l => l !== slot.assigned);
                      
                      if (otherLevels.length > 0) {
                          slot.assigned = otherLevels[Math.floor(Math.random() * otherLevels.length)];
                          let nextBadness = calculateBadness(nextSlots);

                          if (nextBadness < currentBadness) {
                              currentSlots = nextSlots;
                              currentBadness = nextBadness;
                          }
                      }
                      
                      if (currentBadness < -200) break; 
                  }

                  if (currentBadness < minGlobalBadness) {
                      minGlobalBadness = currentBadness;
                      bestGlobalSolution = JSON.parse(JSON.stringify(currentSlots));
                  }
              }

              return bestGlobalSolution;
          };

          const finalSolution = hillClimbingSolve();

          if (finalSolution) {
              let p = { vd: 0, h: 0, b: 0 };
              let t = { vd: new Set(), h: new Set() };
              finalSolution.forEach(s => {
                  if(s.assigned === 'vd') { p.vd += s.point; t.vd.add(s.type); }
                  else if(s.assigned === 'h') { p.h += s.point; t.h.add(s.type); }
                  else p.b += s.point;
              });
              console.log(`%c[HILL CLIMBING] Kết quả tối ưu: VD=${p.vd.toFixed(2)} | H=${p.h.toFixed(2)}`, "color: blue; font-weight: bold; font-size: 14px");
              console.log(`Độ phủ loại câu: VD(${Array.from(t.vd).join(',')}) - H(${Array.from(t.h).join(',')})`);
          }

          const findNeediestUnit = (units, requiredLevel) => {
              let candidates = units.map(u => {
                  let deficit = u.targetScore - u.currentScore;
                  let score = deficit;
                  if (requiredLevel === 'vd') {
                       if (u.isImportant) score += 2.0; 
                       else score -= 3.0; 
                  }
                  score += (Math.random() * 0.2); 
                  return { unit: u, score: score };
              });
              candidates.sort((a, b) => b.score - a.score);
              return candidates[0].unit;
          };

          if (finalSolution) {
              finalSolution.sort((a, b) => b.point - a.point);
              
              finalSolution.forEach(slot => {
                  let level = slot.assigned;
                  let unit = findNeediestUnit(units, level);
                  
                  if (!unit.cells[slot.type]) unit.cells[slot.type] = {};
                  if (!unit.cells[slot.type][level]) unit.cells[slot.type][level] = 0;

                  unit.cells[slot.type][level]++;
                  unit.currentScore += slot.point;
              });
          }

          // 5. CHUẨN BỊ DỮ LIỆU HIỂN THỊ
          let matrixRows = "";
          let grandTotal = {
              cols: { mcq_b:0, mcq_h:0, mcq_vd:0, ds_b:0, ds_h:0, ds_vd:0, tln_b:0, tln_h:0, tln_vd:0, tl_b:0, tl_h:0, tl_vd:0 },
              rowSums: { b:0, h:0, vd:0 },
              points: { b:0, h:0, vd:0 }
          };

          units.forEach((u, idx) => {
              let rowB = u.cells.mcq.b + u.cells.ds.b + u.cells.tln.b + u.cells.tl.b;
              let rowH = u.cells.mcq.h + u.cells.ds.h + u.cells.tln.h + u.cells.tl.h;
              let rowVD = u.cells.mcq.vd + u.cells.ds.vd + u.cells.tln.vd + u.cells.tl.vd;
              let rowTotal = rowB + rowH + rowVD;

              if (rowTotal > 0) {
                  let actualPercent = (u.currentScore * 10).toFixed(1);
                  matrixRows += `
              ROW_${idx + 1}:
              - Chuong: "${u.chapter}"
              - Bai: "${u.name}"
              - MCQ: B=${u.cells.mcq.b}, H=${u.cells.mcq.h}, VD=${u.cells.mcq.vd}
              - DS:  B=${u.cells.ds.b},  H=${u.cells.ds.h},  VD=${u.cells.ds.vd}
              - TLN: B=${u.cells.tln.b}, H=${u.cells.tln.h}, VD=${u.cells.tln.vd}
              - TL:  B=${u.cells.tl.b},  H=${u.cells.tl.h},  VD=${u.cells.tl.vd}
              - TONG_NGANG: B=${rowB}, H=${rowH}, VD=${rowVD}
              - TI_LE: "${actualPercent}%"
              ------------------------------------------
              `;
                  
                  grandTotal.cols.mcq_b += u.cells.mcq.b; grandTotal.cols.mcq_h += u.cells.mcq.h; grandTotal.cols.mcq_vd += u.cells.mcq.vd;
                  grandTotal.cols.ds_b += u.cells.ds.b;   grandTotal.cols.ds_h += u.cells.ds.h;   grandTotal.cols.ds_vd += u.cells.ds.vd;
                  grandTotal.cols.tln_b += u.cells.tln.b; grandTotal.cols.tln_h += u.cells.tln.h; grandTotal.cols.tln_vd += u.cells.tln.vd;
                  grandTotal.cols.tl_b += u.cells.tl.b;   grandTotal.cols.tl_h += u.cells.tl.h;   grandTotal.cols.tl_vd += u.cells.tl.vd;
              }
          });

          grandTotal.rowSums.b = grandTotal.cols.mcq_b + grandTotal.cols.ds_b + grandTotal.cols.tln_b + grandTotal.cols.tl_b;
          grandTotal.rowSums.h = grandTotal.cols.mcq_h + grandTotal.cols.ds_h + grandTotal.cols.tln_h + grandTotal.cols.tl_h;
          grandTotal.rowSums.vd = grandTotal.cols.mcq_vd + grandTotal.cols.ds_vd + grandTotal.cols.tln_vd + grandTotal.cols.tl_vd;

          grandTotal.points.b = (grandTotal.cols.mcq_b * scores.mcq) + (grandTotal.cols.ds_b * scores.ds) + (grandTotal.cols.tln_b * scores.tln) + (grandTotal.cols.tl_b * scores.tl);
          grandTotal.points.h = (grandTotal.cols.mcq_h * scores.mcq) + (grandTotal.cols.ds_h * scores.ds) + (grandTotal.cols.tln_h * scores.tln) + (grandTotal.cols.tl_h * scores.tl);
          grandTotal.points.vd = (grandTotal.cols.mcq_vd * scores.mcq) + (grandTotal.cols.ds_vd * scores.ds) + (grandTotal.cols.tln_vd * scores.tln) + (grandTotal.cols.tl_vd * scores.tl);
          
          let totalPointsFinal = grandTotal.points.b + grandTotal.points.h + grandTotal.points.vd;
          let scoreDetails = JSON.stringify(scores);

          // ============================================
          // PROMPT BƯỚC 1: CHỈ TẠO MA TRẬN + ĐẶC TẢ
          // ============================================
          const SYSTEM_RULES = `
[STRICT RULE: OUTPUT ONLY RAW HTML]
1. NEVER REPEAT THE USER PROMPT.
2. DO NOT START WITH "HERE IS YOUR CODE" OR SIMILAR PREFACES.
3. OUTPUT MUST START IMMEDIATELY WITH THE HTML TAG: <h2
4. NO MARKDOWN FORMATTING (NO \`\`\`html).
[USER REQUEST START]:
`;
          
          const promptStep1 = SYSTEM_RULES + `
Bạn là chuyên gia khảo thí hàng đầu Việt Nam. Bạn am hiểu sâu sắc sách giáo khoa ${book_series} lớp ${grade} và chương trình giáo dục phổ thông 2018.

NHIỆM VỤ: Tạo CHỈNH XÁC 2 phần HTML:
1. MA TRẬN ĐỀ KIỂM TRA (19 cột)
2. BẢN ĐẶC TẢ ĐỀ (16 cột)

[QUY TẮC TUYỆT ĐỐI - ĐỌC KỸ]
1. KHÔNG bổ sung, KHÔNG sửa đổi số liệu dữ liệu đã tính. CHỈ lấy dữ liệu này điền vào bảng.
2. MA TRẬN và ĐẶC TẢ phải KHỚP 100% về số lượng câu hỏi ở từng mức độ.
3. KHÔNG BỎ SÓT một đơn vị kiến thức nào từ DỮ LIỆU ĐÃ TÍNH.
4. Cột "Yêu cầu cần đạt" ở Đặc tả: CHỈ viết cho những mức độ có số lượng > 0. Dùng động từ tương ứng (Nêu được, Giải thích được, Tính toán được).
5. Bắt đầu OUTPUT ngay bằng tag <h2> cho Ma trận, không có lời dẫn.

### DỮ LIỆU ĐÃ TÍNH:
${matrixRows}

### THÔNG TIN HỖ TRỢ:
- Môn: ${subject} - Lớp ${grade} - Bộ sách: ${book_series}
- Cấu trúc: ${structureInfo}
- Hệ số: ${scoreDetails}
- Loại kỳ thi: ${exam_type} - Học kỳ ${semester}
- Thời gian: ${time} phút

### PHẦN 1: MA TRẬN ĐỀ KIỂM TRA
Yêu cầu: Dòng đầu tiên phải là:
<h2 style="color:#0044cc; text-align:center; text-transform:uppercase;">A. MA TRẬN ĐỀ KIỂM TRA ${exam_type} ${semester} <br> Môn: ${subject} - Lớp ${grade}</h2>

Sau đó, điền dữ liệu vào bảng HTML với cấu trúc 19 cột chính xác:
<table border="1" style="border-collapse:collapse; width:100%; text-align:center; font-family: Arial, sans-serif;">
<thead>
    <tr>
        <th rowspan="4">TT</th>
        <th rowspan="4">Chủ đề/Chương</th>
        <th rowspan="4">Nội dung/Đơn vị kiến thức</th>
        <th colspan="12">Mức độ đánh giá</th>
        <th colspan="3">Tổng số câu</th>
        <th rowspan="4">Tỉ lệ %</th>
    </tr>
    <tr>
        <th colspan="9">TNKQ</th>
        <th colspan="3">Tự luận</th>
        <th rowspan="3">Tổng<br>Biết</th>
        <th rowspan="3">Tổng<br>Hiểu</th>
        <th rowspan="3">Tổng<br>VD</th>
    </tr>
    <tr>
        <th colspan="3">Nhiều lựa chọn</th>
        <th colspan="3">Đúng-Sai</th>
        <th colspan="3">Trả lời ngắn</th>
        <th colspan="3">Tự luận</th>
    </tr>
    <tr>
        <th>Biết</th><th>Hiểu</th><th>VD</th>
        <th>Biết</th><th>Hiểu</th><th>VD</th>
        <th>Biết</th><th>Hiểu</th><th>VD</th>
        <th>Biết</th><th>Hiểu</th><th>VD</th>
    </tr>
</thead>
<tbody>
[ĐIỀN CÁC DÒNG UNIT VÀO ĐÂY - MỖI UNIT MỘT DÒNG]
</tbody>
<tfoot>
    <tr>
        <th colspan="3">Tổng số câu</th>
        <th>${grandTotal.cols.mcq_b}</th> <th>${grandTotal.cols.mcq_h}</th> <th>${grandTotal.cols.mcq_vd}</th>
        <th>${grandTotal.cols.ds_b}</th>  <th>${grandTotal.cols.ds_h}</th>  <th>${grandTotal.cols.ds_vd}</th>
        <th>${grandTotal.cols.tln_b}</th> <th>${grandTotal.cols.tln_h}</th> <th>${grandTotal.cols.tln_vd}</th>
        <th>${grandTotal.cols.tl_b}</th>  <th>${grandTotal.cols.tl_h}</th>  <th>${grandTotal.cols.tl_vd}</th>
        <th>${grandTotal.rowSums.b}</th> <th>${grandTotal.rowSums.h}</th> <th>${grandTotal.rowSums.vd}</th>
        <th></th>
    </tr>
    <tr>
        <th colspan="3">Tổng điểm</th>
        <th colspan="3">${((grandTotal.cols.mcq_b+grandTotal.cols.mcq_h+grandTotal.cols.mcq_vd)*scores.mcq).toFixed(2)}</th>
        <th colspan="3">${((grandTotal.cols.ds_b+grandTotal.cols.ds_h+grandTotal.cols.ds_vd)*scores.ds).toFixed(2)}</th>
        <th colspan="3">${((grandTotal.cols.tln_b+grandTotal.cols.tln_h+grandTotal.cols.tln_vd)*scores.tln).toFixed(2)}</th>
        <th colspan="3">${((grandTotal.cols.tl_b+grandTotal.cols.tl_h+grandTotal.cols.tl_vd)*scores.tl).toFixed(2)}</th>
        <th>${grandTotal.points.b.toFixed(2)}</th>
        <th>${grandTotal.points.h.toFixed(2)}</th>
        <th>${grandTotal.points.vd.toFixed(2)}</th>
        <th>${totalPointsFinal.toFixed(1)}</th>
    </tr>
    <tr>
        <th colspan="3">Tỉ lệ %</th>
        <th colspan="3"></th><th colspan="3"></th><th colspan="3"></th><th colspan="3"></th>
        <th>${(grandTotal.points.b*10).toFixed(0)}%</th>
        <th>${(grandTotal.points.h*10).toFixed(0)}%</th>
        <th>${(grandTotal.points.vd*10).toFixed(0)}%</th>
        <th>100%</th>
    </tr>
</tfoot>
</table>

### PHẦN 2: BẢN ĐẶC TẢ ĐỀ
Sau bảng Ma trận, ngay lập tức thêm:
<hr>
<h2 style="color:blue">B: BẢN ĐẶC TẢ</h2>
<table border="1" style="border-collapse:collapse; width:100%; text-align:center;">
<thead>
    <tr>
        <th rowspan="4">TT</th>
        <th rowspan="4">Chủ đề/Chương</th>
        <th rowspan="4">Nội dung/Đơn vị kiến thức</th>
        <th rowspan="4">Yêu cầu cần đạt</th>
        <th colspan="12">Số câu hỏi ở các mức độ đánh giá</th>
    </tr>
    <tr>
        <th colspan="9">TNKQ</th>
        <th colspan="3">Tự luận (TL)</th>
    </tr>
    <tr>
        <th colspan="3">Nhiều lựa chọn</th>
        <th colspan="3">Đúng-Sai</th>
        <th colspan="3">Trả lời ngắn</th>
        <th colspan="3"></th>
    </tr>
    <tr>
        <th>Biết</th><th>Hiểu</th><th>VD</th>
        <th>Biết</th><th>Hiểu</th><th>VD</th>
        <th>Biết</th><th>Hiểu</th><th>VD</th>
        <th>Biết</th><th>Hiểu</th><th>VD</th>
    </tr>
</thead>
<tbody>
[ĐIỀN CÁC DÒNG UNIT VÀO ĐÂY - MỖI UNIT MỘT DÒNG]
</tbody>
<tfoot>
    <tr>
        <th colspan="4">Tổng số câu</th>
        <th>${grandTotal.cols.mcq_b}</th><th>${grandTotal.cols.mcq_h}</th><th>${grandTotal.cols.mcq_vd}</th>
        <th>${grandTotal.cols.ds_b}</th><th>${grandTotal.cols.ds_h}</th><th>${grandTotal.cols.ds_vd}</th>
        <th>${grandTotal.cols.tln_b}</th><th>${grandTotal.cols.tln_h}</th><th>${grandTotal.cols.tln_vd}</th>
        <th>${grandTotal.cols.tl_b}</th><th>${grandTotal.cols.tl_h}</th><th>${grandTotal.cols.tl_vd}</th>
    </tr>
    <tr>
        <th colspan="4">Tổng điểm</th>
        <th colspan="3">${((grandTotal.cols.mcq_b+grandTotal.cols.mcq_h+grandTotal.cols.mcq_vd)*scores.mcq).toFixed(2)}</th>
        <th colspan="3">${((grandTotal.cols.ds_b+grandTotal.cols.ds_h+grandTotal.cols.ds_vd)*scores.ds).toFixed(2)}</th>
        <th colspan="3">${((grandTotal.cols.tln_b+grandTotal.cols.tln_h+grandTotal.cols.tln_vd)*scores.tln).toFixed(2)}</th>
        <th colspan="3">${((grandTotal.cols.tl_b+grandTotal.cols.tl_h+grandTotal.cols.tl_vd)*scores.tl).toFixed(2)}</th>
    </tr>
    <tr>
        <th colspan="4">Tỉ lệ %</th>
        <th colspan="3">30%</th>
        <th colspan="3">20%</th>
        <th colspan="3">20%</th>
        <th colspan="3">30%</th>
    </tr>
</tfoot>
</table>

[CẢNH BÁO TÍNH ĐỒNG BỘ 100% - ĐỌC KỸ VÀ TUÂN THỦ NGHIÊM NGẶT]:
      1. ĐỒNG BỘ SỐ LIỆU: Số lượng câu hỏi của từng mức độ (Biết/Hiểu/Vận dụng) và từng loại câu (MCQ, ĐS, TLN, TL) ở mỗi bài học BẮT BUỘC PHẢI KHỚP TỪNG CHỮ SỐ với Phần 1 (Ma trận). Nếu Ma trận có 2 câu MCQ Biết ở Bài 1, thì Đặc tả cũng phải ghi đúng số 2 ở cột đó.
      2. Ma trận có bao nhiêu đơn vị kiến thức, Bản đặc tả phải có chính xác. TUYỆT ĐỐI KHÔNG bỏ sót.
      3. CÁCH VIẾT CỘT "YÊU CẦU CẦN ĐẠT": CHỈ viết yêu cầu cho những mức độ có số lượng câu hỏi > 0. 
         - Nếu có câu ở mức Biết: Bắt đầu bằng các động từ "Nêu được", "Nhận biết được", "Kể tên", "Phát biểu được".
         - Nếu có câu ở mức Hiểu: Bắt đầu bằng "Giải thích được", "Phân biệt được", "Mô tả được", "So sánh được".
         - Nếu có câu ở mức Vận dụng: Bắt đầu bằng "Tính toán được", "Vận dụng kiến thức để giải quyết", "Xác định được".
         - Mỗi ý yêu cầu cần đạt tách thành dòng riêng biệt.
      4. Bắt buộc tính lại Tổng số câu và Tổng điểm ở phần <tfoot> sao cho khớp 100% với Phần 1
	  ## YÊU CẦU ĐẶC BIỆT VỀ NGUỒN KIẾN THỨC (TUÂN THỦ TUYỆT ĐỐI):
	1. **Ràng buộc Nguồn (Source-Grounded):**
   - CHỈ ĐƯỢC PHÉP sử dụng các khái niệm, dữ kiện đã xuất hiện trong phần "DỮ LIỆU NỘI DUNG".
   - NẾU phần dữ liệu cung cấp quá sơ sài, bạn CHỈ ĐƯỢC phép mở rộng dựa trên kiến thức chuẩn của bộ sách ${book_series} lớp ${grade}.
   - TUYỆT ĐỐI KHÔNG đưa vào các kiến thức của lớp trên hoặc các chủ đề không liên quan (Ví dụ: Không ra đề về Python nếu nội dung là Scratch).
	2. **Chính xác về Thuật ngữ:**
   - Sử dụng 100% thuật ngữ mới theo danh pháp quốc tế của chương trình 2018 (Ví dụ: Oxygen, Potassium, Carbon dioxide, Base, Acid, Salt, Joule...).
	3. **Logic Đặc thù môn học:**
   - Tin học (Lớp 6-9): Tập trung Scratch và thuật toán cơ bản.
   - Tin học (Lớp 10-12): Tập trung Python, Cấu trúc dữ liệu và AI cơ bản.
   - Ngoại ngữ: Từ vựng và cấu trúc câu phải tương đương bậc năng lực yêu cầu cho lớp ${grade}.
	4. **Cấm ảo giác (Anti-Hallucination):**
   - KHÔNG bịa đặt số liệu, tên nhà khoa học hoặc các sự kiện lịch sử không có thật.
   - Nếu yêu cầu tạo đề có câu hỏi trắc nghiệm, các đáp án nhiễu phải có tính logic, không được vô lý hoặc gây hiểu lầm.
	# CẢNH BÁO
			Nếu bạn vi phạm bất kỳ quy tắc nào ở trên (đặc biệt là việc lấy nhầm kiến thức lớp khác hoặc dùng thuật ngữ cũ), nội dung của bạn sẽ bị loại bỏ hoàn toàn.
  5. QUY TẮC VỀ HÌNH ẢNH (ZERO-FAKE-IMAGES):
         - TUYỆT ĐỐI KHÔNG SỬ DỤNG THẺ <img>, không chèn link ảnh (URL) tự bịa (vì nó sẽ gây lỗi hiển thị).
         - Trình bày câu hỏi dưới dạng Text. Nếu câu hỏi bắt buộc phải có hình (mạch điện, đồ thị, tế bào...), hãy đặt 1 placeholder bằng text in đậm màu đỏ: <br><b style="color:red">[GIÁO VIÊN CHÈN HÌNH MINH HỌA VÀO ĐÂY]</b><br>

[BẮT ĐẦU NGAY - KHÔNG CÓ LỜI DẪN]
          `;

          // ============================================
          // GỌI API STEP 1
          // ============================================
          const genAI = new GoogleGenerativeAI(apiKey);
          const model = genAI.getGenerativeModel(
            { model: 'gemini-2.5-pro' },
            { baseUrl: 'https://gateway.ai.cloudflare.com/v1/a59c0991f0b291394bbe2fca8ba2694f/hien-demo/google-ai-studio' }
          );

          const result = await model.generateContentStream({
              contents: [{ role: "user", parts: [{ text: promptStep1 }] }],
              generationConfig: {
                  temperature: 0.1,
                  maxOutputTokens: 6000,
                  topP: 0.8,
                  topK: 10
              }
          });

          const { readable, writable } = new TransformStream();
          const writer = writable.getWriter();
          const encoder = new TextEncoder();

          (async () => {
              let hasDeducted = false;
              try {
                  for await (const chunk of result.stream) {
                      let text = chunk.text(); 
                      
                      if (text) {
                          // Trừ tiền ở bước 1
                          if (!hasDeducted && env.TEST_TOOL && license_key) {
                              hasDeducted = true; 
                              context.waitUntil((async () => {
                                  try {
                                      const current = await env.TEST_TOOL.get(license_key);
                                      if (current) {
                                          const newCredit = Math.max(0, parseInt(current) - 1);
                                          await env.TEST_TOOL.put(license_key, newCredit.toString());
                                      }
                                  } catch (kvErr) {
                                      console.error("KV Error:", kvErr);
                                  }
                              })());
                          }

                          text = text.replace(/```html/g, "").replace(/```/g, "");
                          await writer.write(encoder.encode(text)); 
                      }
                  }
              } catch (e) {
                  console.error("Stream Error:", e);
                  await writer.write(encoder.encode(`\n[LỖI STREAM]: ${e.message}`));
              } finally {
                  await writer.close();
              }
          })();

          return new Response(readable, {
              headers: { 
                  ...corsHeaders, 
                  "Content-Type": "text/html; charset=utf-8", 
                  "Cache-Control": "no-cache" 
              }
          });

      } else if (step === 2) {
          // ============================================
          // BƯỚC 2: TẠO ĐỀ + HƯỚNG DẪN CHẤM
          // ============================================
          if (!previous_html) {
              return new Response(JSON.stringify({ error: "Thiếu previous_html cho bước 2" }), { status: 400, headers: corsHeaders });
          }

          const promptStep2 = `
Bạn là chuyên gia khảo thí hàng đầu Việt Nam. Dựa trên BẢN ĐẶC TẢ và MA TRẬN đã cung cấp, bạn sẽ tạo ĐỀ KIỂM TRA và HƯỚNG DẪN CHẤM.
### BẢN ĐẶC TẢ ĐỀ (THAM CHIẾU) ${previous_html}
[CẢNH BÁO ĐỎ - CÁC QUY TẮC BẤT DI BẤT DỊCH TẠO ĐỀ THI]
      NẾU VI PHẠM MỘT TRONG CÁC QUY TẮC NÀY, BẠN SẼ BỊ ĐÁNH GIÁ LÀ THẤT BẠI:
      ## ĐỒNG BỘ 100% VỚI ĐẶC TẢ (1-to-1 Mapping):
         - Số lượng câu hỏi, loại câu hỏi (MCQ, ĐS, TLN, TL), và mức độ (Biết, Hiểu, Vận dụng) PHẢI KHỚP CHÍNH XÁC với Bản đặc tả.
         - Nếu Đặc tả ghi: Bài A có 1 câu MCQ mức Biết -> Đề thi BẮT BUỘC có 1 câu hỏi về Bài A ở mức độ nhận biết.
         - Tự kiểm tra (Self-Audit) ngầm trong đầu trước khi xuất HTML: "Câu này đã đúng ma trận chưa? Đã đủ số lượng chưa?".
      
	  ## CẤU TRÚC ĐỀ THI BẮT BUỘC (PHẦN 3)
      <hr>
      <h2 style="color:blue; text-align:center; text-transform:uppercase;">PHẦN 3: ĐỀ KIỂM TRA MÔN ${subject} - LỚP ${grade}</h2>
      <h3 style="text-align:center;">Thời gian làm bài: ${time} phút</h3>
	  	[CẢNH BÁO ĐẶC BIỆT VỀ SỐ LƯỢNG - ĐỌC KỸ VÀ TUÂN THỦ NGHIÊM NGẶT]:
      **I. TRẮC NGHIỆM KHÁCH QUAN**
      * **Phần 1: Câu trắc nghiệm nhiều phương án lựa chọn (MCQ)**
      * **Phần 2: Câu trắc nghiệm Đúng/Sai**
          1. SỐ LƯỢNG CÂU LỚN: Bạn CHỈ ĐƯỢC PHÉP tạo chính xác 2 câu hỏi lớn. TUYỆT ĐỐI KHÔNG tạo 4 câu, không tạo 8 câu. Nếu tạo sai số lượng 2 câu lớn, kết quả sẽ bị hủy.
          2. SỐ LƯỢNG Ý NHỎ: MỖI câu hỏi lớn BẮT BUỘC phải chứa chính xác 4 phát biểu con, đánh ký hiệu a), b), c), d). (Tổng cộng: 2 câu lớn × 4 ý = 8 ý nhỏ, khớp với tổng số 8 của ma trận).
          3. CÁCH GOM KIẾN THỨC: Nếu ma trận phân bổ câu Đ/S ở nhiều bài học khác nhau, BẮT BUỘC phải gom nhóm (tổng hợp) kiến thức của các bài đó lại để thiết kế thành 2 tình huống/bối cảnh chung cho 2 câu lớn này. Không được tách lẻ mỗi bài 1 câu.
          4. ĐỊNH DẠNG HTML BẮT BUỘC (Cho từng câu lớn):
             - Dòng hướng dẫn (in nghiêng): "Trong mỗi ý a), b), c), d) dưới đây, thí sinh chọn phương án đúng hoặc sai. (Đúng ghi Đ; Sai ghi S)."
             - Tiêu đề: "Câu [Số thứ tự]: [Phần dẫn/Tình huống chung]"
             - Kẻ bảng 2 cột: Cột 1 tiêu đề "Nội dung" (chứa 4 dòng ý a, b, c, d); Cột 2 tiêu đề "Đúng/Sai" (các ô ở dưới để trống rỗng).
             - TUYỆT ĐỐI KHÔNG điền đáp án Đ/S vào phần đề thi này.
		* **Phần 2: Câu Trả lời ngắn**
		- Số lượng câu hỏi bắt buộc phải khớp với ma trận và bản đặc tả
		### YÊU CẦU ĐẶC BIỆT CHO PHẦN "TRẢ LỜI NGẮN" (STRICT CONCISENESS):
		1. **Nguyên tắc "Siêu Ngắn" (Zero-Fluff Policy):**
	   - Cắt bỏ hoàn toàn lời dẫn dắt, bối cảnh, giả định không cần thiết (Ví dụ: Bỏ "Trong phòng thí nghiệm...", bỏ "Một học sinh thực hiện thí nghiệm...").
	   - **Cấu trúc bắt buộc:** "Cho [Dữ kiện]. Tính/Tìm [Yêu cầu]."
    2. **Ví dụ mẫu (Hãy làm theo phong cách này):**
	   - *SAI (Quá dài):* "Một chiếc xe ô tô có khối lượng là 1000kg đang chuyển động trên đường thẳng với vận tốc 10m/s. Hãy tính động năng của xe."
	   - *ĐÚNG (Chuẩn):* "Một ô tô 1000 kg chuyển động với tốc độ 10 m/s. Tính động năng của xe."
	   - *ĐÚNG (Chuẩn):* "Tính pH của dung dịch HCl 0,01M."
      **II. TỰ LUẬN**
      - Liệt kê các câu tự luận, ghi rõ số điểm bên cạnh (Ví dụ: Câu 1 (1.0 điểm): ...).
    3. **Định dạng đáp án (Nếu là điền khuyết):**
   	- Câu hỏi phải được thiết kế để đáp án là một **con số cụ thể** hoặc một **từ/cụm từ duy nhất**. Không ra câu hỏi mở.

### PHẦN 4: HƯỚNG DẪN CHẤM
<h2 style="color:blue">HƯỚNG DẪN CHẤM</h2>

**Phần 1 (MCQ):**
<table border="1" style="border-collapse:collapse;">
<tr>
  <td style="font-weight:bold; text-align:center;">Câu</td>
  <td style="text-align:center;">1</td>
  <td style="text-align:center;">2</td>
  ...
</tr>
<tr>
  <td style="font-weight:bold; text-align:center;">Đáp án</td>
  <td style="text-align:center;">A</td>
  <td style="text-align:center;">B</td>
  ...
</tr>
</table>

**Phần 2 (Đúng/Sai):**
[Bảng gồm 2 cột: "Nội dung" | "Đúng/Sai" với đáp án đầy đủ]

**Phần 3 (Trả lời ngắn):**
[Liệt kê đáp án đúng của mỗi câu]

**Tự luận:**
[Bảng 3 cột: Câu | Nội dung/Đáp án chi tiết | Điểm]
*** QUY ĐỊNH KỸ THUẬT (BẮT BUỘC):**
	  1. **Định dạng:** Chỉ trả về mã **HTML Table** ('<table border="1">...</table>') cho các bảng.
    2. **Không dùng Markdown:** Tuyệt đối không dùng \`\`\`html\`\`\` hoặc |---| .
    3. **Xuống dòng (QUAN TRỌNG):**
      - Trong HTML, ký tự xuống dòng (\n) không có tác dụng. **BẮT BUỘC phải dùng thẻ '<br>'** để ngắt dòng.
      - **Tuyệt đối không** viết các đáp án nối liền nhau trên cùng một dòng.
    4. **Công thức Toán:** Sử dụng LaTeX chuẩn, bao quanh bởi dấu $$ (ví dụ: $$x^2 + \sqrt{5}$$). Không dùng MathML.               
    5. **Khoảng cách giữa các câu:** Giữa Câu 1 và Câu 2 (và các câu tiếp theo) phải có thêm một thẻ '<br>' hoặc dùng thẻ '<p>' bao quanh từng câu để tạo khoảng cách rõ ràng, dễ đọc.
	###**Trước khi trả lời, hãy dành thời gian phân tích nội bộ các bước logic, tự kiểm tra lỗi sai và trình bày luồng tư duy đó trước khi đưa ra kết quả cuối cùng*
	[BẮT ĐẦU NGAY - KO CÓ LỜI DẪN]
          `;

         // ============================================
          const genAI2 = new GoogleGenerativeAI(apiKey);
          const model2 = genAI2.getGenerativeModel(
            { model: 'gemini-2.5-pro' },
            { baseUrl: 'https://gateway.ai.cloudflare.com/v1/a59c0991f0b291394bbe2fca8ba2694f/hien-demo/google-ai-studio' }
          );

          const result2 = await model2.generateContentStream({
              contents: [{ role: "user", parts: [{ text: promptStep2 }] }],
              generationConfig: {
                  temperature: 0.1,
                  maxOutputTokens: 8000,
                  topP: 0.8,
                  topK: 10
              }
          });

          const { readable: readable2, writable: writable2 } = new TransformStream();
          const writer2 = writable2.getWriter();
          const encoder2 = new TextEncoder();

          (async () => {
              let hasDeducted = false;
              try {
                  for await (const chunk of result2.stream) {
                      let text = chunk.text(); 
                      
                      if (text) {
                          // Trừ tiền ở bước 2
                          if (!hasDeducted && env.TEST_TOOL && license_key) {
                              hasDeducted = true; 
                              context.waitUntil((async () => {
                                  try {
                                      const current = await env.TEST_TOOL.get(license_key);
                                      if (current) {
                                          const newCredit = Math.max(0, parseInt(current) - 1);
                                          await env.TEST_TOOL.put(license_key, newCredit.toString());
                                      }
                                  } catch (kvErr) {
                                      console.error("KV Error:", kvErr);
                                  }
                              })());
                          }

                          text = text.replace(/```html/g, "").replace(/```/g, "");
                          await writer2.write(encoder2.encode(text)); 
                      }
                  }
              } catch (e) {
                  console.error("Stream Error:", e);
                  await writer2.write(encoder2.encode(`\n[LỖI STREAM]: ${e.message}`));
              } finally {
                  await writer2.close();
              }
          })();

          return new Response(readable2, {
              headers: { 
                  ...corsHeaders, 
                  "Content-Type": "text/html; charset=utf-8", 
                  "Cache-Control": "no-cache" 
              }
          });

      } else {
          return new Response(JSON.stringify({ error: "step phải là 1 hoặc 2" }), { status: 400, headers: corsHeaders });
      }

    } catch (error) {
      return new Response(JSON.stringify({ error: `System Error: ${error.message}` }), { 
          status: 500, 
          headers: corsHeaders 
      });
    }
  }
}
