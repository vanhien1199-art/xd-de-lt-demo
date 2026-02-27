// File: functions/api_matrix.js
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
      // Bổ sung lấy tham số step và previous_html từ yêu cầu
      let { 
          license_key, topics, subject, grade, semester, 
          exam_type, time, use_short_answer, book_series,
          step, previous_html
      } = body;

      const timeInt = parseInt(time);

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
    

// 4. THUẬT TOÁN PHÂN BỔ: HILL CLIMBING (LEO ĐỒI - TỰ SỬA LỖI ĐỂ ĐẠT ĐỈNH)
// --- CẤU HÌNH MỤC TIÊU ---
const TARGETS = { vd: 3.0, h: 3.0, b: 4.0 };
const EPSILON = 0.001; 
const MAX_ATTEMPTS = 50; // Số lần leo đồi (Reset leo lại từ đầu để tránh kẹt)
const STEPS_PER_CLIMB = 200; // Số bước leo trong mỗi lần

// --- HELPERS ---
const createSlots = () => {
    let slots = [];
    const add = (type, count, score, allowed) => {
        for(let i=0; i<count; i++) slots.push({ type, point: score, allowed, assigned: 'b' }); // Mặc định 'b'
    };
    if (quotas.tl > 0) add('tl', quotas.tl, scores.tl, ['vd', 'h', 'b']);
    if (quotas.tln > 0) add('tln', quotas.tln, scores.tln, ['vd', 'h', 'b']);
    if (quotas.ds > 0) add('ds', quotas.ds, scores.ds, ['h', 'b']);
    if (quotas.mcq > 0) add('mcq', quotas.mcq, scores.mcq, ['vd', 'h', 'b']);
    return slots;
};

// Hàm tính điểm "Độ Xấu" (Càng thấp càng tốt, 0 là hoàn hảo)
const calculateBadness = (slots) => {
    let pts = { vd: 0, h: 0 };
    let types = { vd: new Set(), h: new Set() };
    
    slots.forEach(s => {
        if (s.assigned === 'vd') { pts.vd += s.point; types.vd.add(s.type); }
        if (s.assigned === 'h')  { pts.h += s.point;  types.h.add(s.type); }
    });

    let diffVD = Math.abs(TARGETS.vd - pts.vd);
    let diffH = Math.abs(TARGETS.h - pts.h);
    
    // Yếu tố 1: Phải đúng điểm (Quan trọng nhất - Hệ số phạt 1000)
    let scoreError = (diffVD + diffH) * 1000; 

    // Yếu tố 2: Phải đa dạng (Quan trọng nhì - Điểm thưởng)
    // Càng nhiều loại câu hỏi xuất hiện ở VD/H thì độ xấu càng giảm
    let diversityBonus = (types.vd.size + types.h.size) * 50; 

    return scoreError - diversityBonus;
};

// --- CORE: THUẬT TOÁN LEO ĐỒI ---
const hillClimbingSolve = () => {
    let bestGlobalSolution = null;
    let minGlobalBadness = Infinity;

    // Chạy thử nhiều lần (Restart) để tránh bị kẹt ở đỉnh giả (Local Optima)
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        
        // 1. Khởi tạo ngẫu nhiên
        let currentSlots = createSlots();
        currentSlots.forEach(s => {
            // Random mức độ cho phép
            let validLevels = s.allowed;
            s.assigned = validLevels[Math.floor(Math.random() * validLevels.length)];
        });

        let currentBadness = calculateBadness(currentSlots);

        // 2. Bắt đầu leo đồi (Tinh chỉnh dần dần)
        for (let step = 0; step < STEPS_PER_CLIMB; step++) {
            
            // Sao chép trạng thái hiện tại để thử nghiệm
            // (Clone sâu đơn giản cho array object phẳng)
            let nextSlots = currentSlots.map(s => ({...s})); 
            
            // --- THỰC HIỆN ĐỘT BIẾN (MUTATION) ---
            // Chọn ngẫu nhiên 1 slot và đổi sang mức độ khác
            let randIdx = Math.floor(Math.random() * nextSlots.length);
            let slot = nextSlots[randIdx];
            let otherLevels = slot.allowed.filter(l => l !== slot.assigned);
            
            if (otherLevels.length > 0) {
                // Đổi sang mức mới
                slot.assigned = otherLevels[Math.floor(Math.random() * otherLevels.length)];
                
                // Tính điểm mới
                let nextBadness = calculateBadness(nextSlots);

                // --- QUYẾT ĐỊNH ---
                // Nếu sửa xong mà thấy tốt hơn (Badness giảm), thì giữ lại thay đổi đó
                if (nextBadness < currentBadness) {
                    currentSlots = nextSlots; // Chấp nhận trạng thái mới
                    currentBadness = nextBadness;
                }
            }
            
            // Nếu đã đạt điểm tuyệt đối (Badness cực thấp âm), có thể dừng sớm vòng lặp con
            if (currentBadness < -200) break; 
        }

        // Kiểm tra xem lần leo núi này có tìm ra kết quả tốt nhất lịch sử không
        if (currentBadness < minGlobalBadness) {
            minGlobalBadness = currentBadness;
            bestGlobalSolution = JSON.parse(JSON.stringify(currentSlots));
        }
    }

    return bestGlobalSolution;
};

// --- MAIN EXECUTION ---
const finalSolution = hillClimbingSolve();

// In kết quả debug
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

// --- APPLY TO UNITS ---
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
    // Sắp xếp điểm to lên trước để fill vào Unit dễ hơn
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
              // Format dữ liệu rõ ràng để AI dễ điền
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

      // =================================================================================
		const SYSTEM_RULES = `
		[STRICT RULE: OUTPUT ONLY RAW HTML]
		1. NEVER REPEAT THE USER PROMPT.
		2. DO NOT START WITH "HERE IS YOUR CODE" OR SIMILAR PREFACES.
		3. OUTPUT MUST START IMMEDIATELY WITH THE HTML TAG: <h2
		4. NO MARKDOWN FORMATTING (NO \`\`\`html).
		[USER REQUEST START]:
		`;
      
      // 6. TẠO PROMPT TÁCH LÀM 2 BƯỚC
      let prompt = "";

      if (step === 1 || !step) { // BƯỚC 1: CHỈ TẠO MA TRẬN VÀ ĐẶC TẢ
          prompt = SYSTEM_RULES + `
     Bạn là chuyên gia khảo thí hàng đầu Việt Nam. Bạn am hiểu sâu sắc sách giáo khoa ${book_series} lớp 6, lớp 7, lớp 8, lớp 9, lớp 10, lớp 11, lớp 12 và chương trình giáo dục phổ thông 2018 (Ban hành kèm theo Thông tư số 32/2018/TT-BGDĐT ngày 26 tháng 12 năm 2018 của Bộ trưởng Bộ Giáo dục và Đào tạo).
	 Nhiệm vụ của bạn là Chuyển dữ liệu đã tính toán thành HTML và xây dựng bản đặc tả đề kiểm tra theo các yêu cầu dưới đây.

      **QUY TẮC BẤT DI BẤT DỊCH:**
      1. **TUYỆT ĐỐI KHÔNG TÍNH TOÁN LẠI:** Chỉ được phép lấy các con số trong phần "DỮ LIỆU ĐÃ TÍNH" để điền vào bảng.
      2. **QUAN HỆ CHẶT CHẼ (LOGIC DÂY CHUYỀN):**
         - **Bản đặc tả (Phần 2)** phải khớp 100% số liệu với **Ma trận (Phần 1)**.
      3. **KHÔNG** nói chuyện phím. Bắt đầu ngay bằng mã HTML.
	  
      **NGUYÊN TẮC:**
      1. KHÔNG được dừng lại khi chưa hoàn thành đủ 2 phần (Ma trận và Bản đặc tả).
      2. KHÔNG nói chuyện phím. Chỉ xuất HTML.
      3. Dùng số liệu ĐÃ TÍNH SẴN ở dưới, KHÔNG tự tính lại.

      ### DỮ LIỆU ĐÃ TÍNH (Sử dụng số liệu này):
      ${matrixRows}

      ### THÔNG TIN:
      - Môn: ${subject} - Lớp ${grade} - Bộ sách: ${book_series}
      - Cấu trúc: ${structureInfo}
      - Hệ số: ${scoreDetails}

      ### OUTPUT YÊU CẦU 1: MA TRẬN ĐỀ KIỂM TRA (19 CỘT
	  Yêu cầu bắt buộc: Kết quả trả về dòng đầu tiên phải là:
      <h2 style="color:#0044cc; text-align:center; text-transform:uppercase;">PHẦN 1: MA TRẬN ĐỀ KIỂM TRA ${exam_type} ${semester} <br> Môn: ${subject} - Lớp ${grade}</h2>
     Sau tiêu đề trên,**Hãy điền dữ liệu vào cấu trúc bảng dưới đây*:
	  ** Yêu cầu tuân thủ tuyệt đối chính xác cấu trúc của bảng*
      \`\`\`html
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
            <th>Biết</th><th>Hiểu</th><th>VD</th> <th>Biết</th><th>Hiểu</th><th>VD</th> <th>Biết</th><th>Hiểu</th><th>VD</th> <th>Biết</th><th>Hiểu</th><th>VD</th> </tr>
    </thead>
    <tbody>
        </tbody>
    <tfoot>
        </tfoot>
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
      \`\`\`

      ### OUTPUT YÊU CẦU 2: BẢN ĐẶC TẢ (16 CỘT)
   <hr>
      <h2 style="color:blue">PHẦN 2: BẢN ĐẶC TẢ ĐỀ KIỂM TRA</h2>
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
                    </tbody>
                <tfoot>
                    <tr>
                        <th colspan="4">Tổng số câu</th>
                        <th>(Sum)</th><th>(Sum)</th><th>(Sum)</th>
                        <th>(Sum)</th><th>(Sum)</th><th>(Sum)</th>
                        <th>(Sum)</th><th>(Sum)</th><th>(Sum)</th>
                        <th>(Sum)</th><th>(Sum)</th><th>(Sum)</th>

                    </tr>
                     <tr>
                        <th colspan="4">Tổng điểm</th>
                        <th colspan="3">tổng điểm câu MCQ</th>
                        <th colspan="3">tổng điểm câu ĐS</th>
                        <th colspan="3">tổng điểm câu TLN</th>
                        <th colspan="3">tổng điểm câu Tự luận</th>
                    
                    </tr>
                    <tr>
                        <th colspan="4">Tỉ lệ %</th>
                        <th colspan="3">30%</th>
                        <th colspan="3">20%</th>
                        <th colspan="3">20%</th>
                        <th colspan="3">30%</th>
                </tfoot>
            </table>
		- ** Cột 4: **Yêu cầu cần đạt** (Mô tả chi tiết kiến thức/kỹ năng cần kiểm tra cho từng mức độ Biết/Hiểu/Vận dụng, mỗi ý xuống dòng bằng thẻ '<br>').
      
      **IV. QUY ĐỊNH KỸ THUẬT (BẮT BUỘC):**
			1. **Định dạng:** Chỉ trả về mã **HTML Table** ('<table border="1">...</table>') cho các bảng.
            2. **Không dùng Markdown:** Tuyệt đối không dùng \`\`\`html\`\`\` hoặc |---| .
            3. **Xuống dòng (QUAN TRỌNG):**
               - Trong HTML, ký tự xuống dòng (\n) không có tác dụng. **BẮT BUỘC phải dùng thẻ '<br>'** để ngắt dòng.
      `;
      } 
      else if (step === 2) { // BƯỚC 2: CHỈ TẠO ĐỀ THI VÀ ĐÁP ÁN DỰA VÀO BƯỚC 1
          if (!previous_html) {
              return new Response(JSON.stringify({ error: "Thiếu dữ liệu (previous_html) từ Bước 1" }), { status: 400, headers: corsHeaders });
          }

          prompt = SYSTEM_RULES + `
      Bạn là chuyên gia khảo thí hàng đầu Việt Nam. Bạn am hiểu sâu sắc sách giáo khoa ${book_series} lớp 6, lớp 7, lớp 8, lớp 9, lớp 10, lớp 11, lớp 12 và chương trình giáo dục phổ thông 2018 (Ban hành kèm theo Thông tư số 32/2018/TT-BGDĐT ngày 26 tháng 12 năm 2018 của Bộ trưởng Bộ Giáo dục và Đào tạo).
	  Nhiệm vụ của bạn là xây dựng đề kiểm tra & hướng dẫn chấm theo các yêu cầu dưới đây dựa vào Ma trận và Bản đặc tả từ Bước 1.
      
      **QUY TẮC BẤT DI BẤT DỊCH:**
      1. **QUAN HỆ CHẶT CHẼ (LOGIC DÂY CHUYỀN):**
         - **Đề thi (Phần 3)** phải khớp 100% với **Bản đặc tả và Ma trận** đã được cấp.
         - (Ví dụ: Ma trận có 1 câu MCQ Biết bài A -> Đặc tả phải ghi hành vi Biết bài A -> Đề thi phải có câu đó).
      2. **KHÔNG** nói chuyện phím. Bắt đầu ngay bằng mã HTML.
	  
      **NGUYÊN TẮC:**
      1. KHÔNG được dừng lại khi chưa hoàn thành phần Đề thi và Đáp án.
      2. KHÔNG nói chuyện phím. Chỉ xuất HTML.

     ## YÊU CẦU VỀ NGUỒN KIẾN THỨC (TUÂN THỦ TUYỆT ĐỐI):
	1. **Ràng buộc Nguồn (Source-Grounded):**
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
   
   ### YÊU CẦU ĐẶC BIỆT CHO PHẦN "TRẢ LỜI NGẮN" (STRICT CONCISENESS):
	1. **Nguyên tắc "Siêu Ngắn" (Zero-Fluff Policy):**
	   - Cắt bỏ hoàn toàn lời dẫn dắt, bối cảnh, giả định không cần thiết (Ví dụ: Bỏ "Trong phòng thí nghiệm...", bỏ "Một học sinh thực hiện thí nghiệm...").
	   - **Cấu trúc bắt buộc:** "Cho [Dữ kiện]. Tính/Tìm [Yêu cầu]."
	   - Độ dài tối đa: **Không quá 2 câu** hoặc **dưới 30 từ** cho mỗi câu hỏi.

	2. **Ví dụ mẫu (Hãy làm theo phong cách này):**
	   - *SAI (Quá dài):* "Một chiếc xe ô tô có khối lượng là 1000kg đang chuyển động trên đường thẳng với vận tốc 10m/s. Hãy tính động năng của xe."
	   - *ĐÚNG (Chuẩn):* "Một ô tô 1000 kg chuyển động với tốc độ 10 m/s. Tính động năng của xe."
	   - *ĐÚNG (Chuẩn):* "Tính pH của dung dịch HCl 0,01M."

	3. **Định dạng đáp án (Nếu là điền khuyết):**
   	- Câu hỏi phải được thiết kế để đáp án là một **con số cụ thể** hoặc một **từ/cụm từ duy nhất**. Không ra câu hỏi mở.
	
    # CẢNH BÁO
			Nếu bạn vi phạm bất kỳ quy tắc nào ở trên (đặc biệt là việc lấy nhầm kiến thức lớp khác hoặc dùng thuật ngữ cũ), nội dung của bạn sẽ bị loại bỏ hoàn toàn.
      
      ### DỮ LIỆU MA TRẬN VÀ BẢN ĐẶC TẢ TỪ BƯỚC 1 (Cần bám sát tuyệt đối):
      ${previous_html}

      ### THÔNG TIN:
      - Môn: ${subject} - Lớp ${grade} - Bộ sách: ${book_series}
      - Cấu trúc: ${structureInfo}
      - Hệ số: ${scoreDetails}

      <hr>
      <h2 style="color:blue">PHẦN 3: ĐỀ KIỂM TRA</h2>
	  <h2 style="color:blue">MÔN:${subject} - Lớp ${grade}</h2>
	  <h2 style="color:blue">Thời gian làm bài: 90 phút hoặc 45 phút</h2>
	  
       - Phải soạn đề thi dựa TRỰC TIẾP trên Ma trận và Bản đặc tả đã thiết lập ở trên.
	   - **Số lượng câu hỏi:** Tổng số câu hỏi trong đề phải khớp 100% với tổng số câu trong Ma trận. Tuyệt đối không thừa, không thiếu.
	   - **Phân bổ mức độ:** Mỗi câu hỏi phải tương ứng chính xác với mức độ (Nhận biết, Thông hiểu, Vận dụng) đã quy định cho từng chủ đề/nội dung.
	   - **Kiểm tra chéo (Self-Audit):** Sau khi soạn xong mỗi câu, hãy đối chiếu lại: "Câu này thuộc chủ đề nào? Mức độ gì? Đã có trong ma trận chưa?". Nếu không khớp, phải sửa lại ngay.
	   - Ghi rõ mã số hoặc mức độ đạt được bên cạnh mỗi câu hỏi (nếu ma trận yêu cầu).
      - Đảm bảo đề thi có đúng ${grandTotal.rowSums.b + grandTotal.rowSums.h + grandTotal.rowSums.vd} câu hỏi khớp với ma trận.
	  * Phân chia rõ ràng 2 phần: **I. TRẮC NGHIỆM KHÁCH QUAN** (7.0đ) và **II. TỰ LUẬN** (3.0đ).
      * **Phần I:** Chia thành 3 tiểu mục
                * **Phần 1 (MCQ):
                * **Phần 2 (Đúng-Sai):** Thiết kế dạng 2 câu chùm (1 câu chùm gồm 4 câu con) và  **Kẻ bảng 2 cột: ý | Đúng/Sai.
                * **Phần 3 (Trả lời ngắn): Chỉ ra
      * **Phần II:**(Liệt kê câu hỏi tự luận). ghi rõ điểm số từng câu.
            <h2 style="color:blue">PHẦN 3: **Phần III. ĐÁP ÁN VÀ THANG ĐIỂM**</h2>
       			* **Phần 1 (MCQ):** Bảng gồm 2 hàng:
									Hàng 1: tiêu đề câu hỏi
									Hàng 2: đáp án tương ứng
									Cột 1 (cố định):
									Hàng 1: ghi “Câu” (in đậm, căn giữa)
									Hàng 2: ghi “Đáp án” (căn giữa)
									Từ cột 2 trở đi (số lượng thay đổi):
									Hàng 1: đánh số câu tăng dần từ 1 → n
									Hàng 2: mỗi ô chứa 1 chữ cái in hoa (A/B/C/D/…), là đáp án của câu phía trên
                * **Phần 2 (Đúng-Sai):** Kẻ bảng chi tiết cho từng câu chùm (a-Đ, b-S...).
                * **Phần 3 (Trả lời ngắn):** Liệt kê đáp án đúng.
                * **Tự luận:** Kẻ bảng 3 cột (Câu | Nội dung/Đáp án chi tiết | Điểm).
		**IV. QUY ĐỊNH KỸ THUẬT (BẮT BUỘC):**
			1. **Định dạng:** Chỉ trả về mã **HTML Table** ('<table border="1">...</table>') cho các bảng.
            2. **Không dùng Markdown:** Tuyệt đối không dùng \`\`\`html\`\`\` hoặc |---| .
            3. **Xuống dòng (QUAN TRỌNG):**
               - Trong HTML, ký tự xuống dòng (\n) không có tác dụng. **BẮT BUỘC phải dùng thẻ '<br>'** để ngắt dòng.
               - **Tuyệt đối không** viết các đáp án nối liền nhau trên cùng một dòng.
            4. **Công thức Toán:** Sử dụng LaTeX chuẩn, bao quanh bởi dấu $$ (ví dụ: $$x^2 + \sqrt{5}$$). Không dùng MathML.               
            5. **Định dạng Câu chùm (Đúng/Sai):**
               - Nội dung lệnh hỏi <br>
               - a) Nội dung ý a... <br>
               - b) Nội dung ý b... <br>
               - c) Nội dung ý c... <br>
               - d) Nội dung ý d...
           6. **Khoảng cách giữa các câu:** Giữa Câu 1 và Câu 2 (và các câu tiếp theo) phải có thêm một thẻ '<br>' hoặc dùng thẻ '<p>' bao quanh từng câu để tạo khoảng cách rõ ràng, dễ đọc.
	###**Trước khi trả lời, hãy dành thời gian phân tích nội bộ các bước logic, tự kiểm tra lỗi sai và trình bày luồng tư duy đó trước khi đưa ra kết quả cuối cùng*
	##LƯU Ý QUAN TRỌNG VỀ TỐC ĐỘ:
		- KHÔNG viết lời dẫn.
		- KHÔNG giải thích lại ma trận.
		- Tập trung vào nội dung đề thi ngay lập tức.
      `;
      }

      // 7. GỌI API QUA GATEWAY & LOGIC TRỪ TIỀN TỐI ƯU (CHẠY NGẦM)
      
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel(
        { model: 'Gemini 2.0 Pro' },
        { baseUrl: 'https://gateway.ai.cloudflare.com/v1/a59c0991f0b291394bbe2fca8ba2694f/hien-demo/google-ai-studio' }
      );

      const result = await model.generateContentStream({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 8192,
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
                  // Chỉ lấy text do AI sinh ra để đảm bảo không hiển thị lại Prompt
                  let text = chunk.text(); 
                  
                  if (text) {
                      // BỔ SUNG: CHỈ TRỪ TIỀN KHI LÀ BƯỚC 2 HOẶC TRƯỜNG HỢP KHÔNG CHIA BƯỚC
                      if ((step === 2 || !step) && !hasDeducted && env.TEST_TOOL && license_key) {
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

                      // Làm sạch định dạng Markdown trước khi gửi về client
                      text = text.replace(/```html/g, "").replace(/```/g, "");
                      await writer.write(encoder.encode(text)); 
                  }
              }
          } catch (e) {
              console.error("Stream Error:", e);
              await writer.write(encoder.encode(`\n[LỖI STREAM]: ${e.message}`));
          } finally {
              // Đảm bảo đóng writer trong mọi trường hợp
              await writer.close();
          }
      })();

      // Trả về Response chứa luồng dữ liệu
      return new Response(readable, {
          headers: { 
              ...corsHeaders, 
              "Content-Type": "text/html; charset=utf-8", 
              "Cache-Control": "no-cache" 
          }
      });

    } catch (error) {
      // Bắt lỗi tổng cho khối try chính của hàm onRequest
      return new Response(JSON.stringify({ error: `System Error: ${error.message}` }), { 
          status: 500, 
          headers: corsHeaders 
      });
    }
  }
}



