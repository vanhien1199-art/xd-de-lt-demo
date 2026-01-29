// File: public/js/app.js

// --- GLOBAL VARIABLES ---
window.generatedHTML = "";

document.addEventListener('DOMContentLoaded', () => {
    // 1. Initialize UI
    addTopic();

    // 2. Safe Event Binding
    const bindBtn = (id, handler) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', handler);
    };

    bindBtn('btnAddTopic', addTopic);
    bindBtn('btnGenerate', handleGenerate);
    bindBtn('btnDownloadWord', handleDownloadWord);
    bindBtn('btnCopy', handleCopyContent);

    // 3. Exam Type Logic
    const examTypeSelect = document.getElementById('exam_type');
    if (examTypeSelect) {
        examTypeSelect.addEventListener('change', updatePeriodInputs);
        setTimeout(updatePeriodInputs, 100); 
    }

    // 4. Event Delegation for Dynamic Elements
    const topicContainer = document.getElementById('topics-container');
    if (topicContainer) {
        topicContainer.addEventListener('click', function(e) {
            const target = e.target;
            // Remove Topic
            if (target.closest('.remove-topic-btn')) {
                if(confirm("Xóa chương này?")) target.closest('.topic-wrapper').remove();
            } 
            // Add Unit
            else if (target.closest('.btn-add-unit')) {
                addUnit(target.closest('.topic-wrapper').querySelector('.units-container'));
            } 
            // Remove Unit
            else if (target.closest('.remove-unit-btn')) {
                target.closest('.unit-item').remove();
            }
        });
    }
});

// --- UI HELPERS ---
function updatePeriodInputs() {
    const type = document.getElementById('exam_type').value; 
    document.querySelectorAll('.unit-item').forEach(item => {
        const div1 = item.querySelector('.hk-input-1');
        const input1 = item.querySelector('.unit-p1');
        const div2 = item.querySelector('.hk-input-2');

        if (type === 'hk') {
            div1.classList.remove('hidden'); input1.placeholder = "Nửa đầu kì";
            div2.classList.remove('hidden');
        } else {
            div1.classList.remove('hidden'); input1.placeholder = "Tổng tiết";
            div2.classList.add('hidden');
        }
    });
}

function addTopic() {
    const container = document.getElementById('topics-container');
    const template = document.getElementById('topic-template');
    if (!container || !template) return;
    const clone = template.content.cloneNode(true);
    const unitsContainer = clone.querySelector('.units-container');
    container.appendChild(clone);
    addUnit(unitsContainer);
}

function addUnit(container) {
    const template = document.getElementById('unit-template');
    if (!container || !template) return;
    const clone = template.content.cloneNode(true);
    container.appendChild(clone);
    updatePeriodInputs();
}

// --- GENERATE DATA (API CALL) ---
async function handleGenerate() {
    const btn = document.getElementById('btnGenerate');
    const loading = document.getElementById('loadingMsg');
    const error = document.getElementById('errorMsg');
    const sec = document.getElementById('previewSection');
    const prev = document.getElementById('previewContent');

    loading.classList.remove('hidden'); 
    error.innerText = ""; 
    sec.classList.add('hidden'); 
    prev.innerHTML = ""; 
    btn.disabled = true;

    try {
        const get = id => document.getElementById(id).value.trim();
        const licenseKey = get('license_key');
        
        if (!licenseKey) throw new Error("Vui lòng nhập Mã Kích Hoạt!");

        const topicsData = [];
        let totalP1 = 0, totalP2 = 0;

        document.querySelectorAll('.topic-wrapper').forEach(topicEl => {
            const topicName = topicEl.querySelector('.topic-name').value.trim();
            if (!topicName) return; 
            
            const units = [];
            topicEl.querySelectorAll('.unit-item').forEach(unitEl => {
                const content = unitEl.querySelector('.unit-content').value.trim();
                const p1 = parseInt(unitEl.querySelector('.unit-p1').value) || 0;
                const p2 = parseInt(unitEl.querySelector('.unit-p2').value) || 0;
                
                if (content) {
                    units.push({ content, p1, p2 });
                    totalP1 += p1; 
                    totalP2 += p2;
                }
            });
            
            if (units.length > 0) {
                topicsData.push({ name: topicName, units: units });
            }
        });

        if (topicsData.length === 0) throw new Error("Vui lòng nhập ít nhất 1 Chương và 1 Bài học!");

        const requestData = {
            license_key: licenseKey, 
            subject: get('subject'), 
            grade: get('grade'),
            book_series: document.getElementById('book_series').value,
            semester: get('semester'), 
            exam_type: get('exam_type'), 
            time: get('time_limit'),
            use_short_answer: document.getElementById('use_short').checked,
            totalPeriodsHalf1: totalP1, 
            totalPeriodsHalf2: totalP2, 
            topics: topicsData 
        };

        const res = await fetch('/api_matrix', {
            method: 'POST', 
            headers: {'Content-Type':'application/json'}, 
            body: JSON.stringify(requestData)
        });
        
        if(!res.ok) {
            let t = await res.text(); 
            try { t = JSON.parse(t).error } catch(e){} 
            throw new Error(`Lỗi Server: ${t}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let fullHTML = "";
        
        while(true) {
            const {done, value} = await reader.read();
            if(done) break;
            fullHTML += decoder.decode(value, {stream:true});
        }
        
        // Clean & Format HTML
        let cleanHTML = fullHTML.replace(/```html/g, '').replace(/```/g, '').trim();
        // Add bold to A. B. C. D. for better display
        cleanHTML = cleanHTML.replace(/(\s+)(B\.|C\.|D\.)/g, '<br><b>$2</b>').replace(/(A\.)/g, '<b>$1</b>');

        prev.innerHTML = cleanHTML;
        window.generatedHTML = cleanHTML;
        sec.classList.remove('hidden'); 
        sec.scrollIntoView({behavior:'smooth'});

    } catch(e) { 
        error.innerHTML = `<strong>⚠️ Lỗi:</strong> ${e.message}`; 
        error.classList.remove('hidden'); 
    } finally { 
        loading.classList.add('hidden'); 
        btn.disabled = false; 
    }
}

// --- COPY FUNCTION ---
async function handleCopyContent() {
    const content = document.getElementById('previewContent');
    const btn = document.getElementById('btnCopy');

    if (!window.generatedHTML) {
        alert("Chưa có nội dung để sao chép!");
        return;
    }

    try {
        const type = "text/html";
        const blob = new Blob([window.generatedHTML], { type });
        const data = [new ClipboardItem({ [type]: blob })];
        await navigator.clipboard.write(data);

        const originalHtml = btn.innerHTML;
        btn.classList.add('copied');
        btn.innerHTML = `<i class="fas fa-check"></i> <span>Đã chép!</span>`;
        setTimeout(() => {
            btn.classList.remove('copied');
            btn.innerHTML = originalHtml;
        }, 2000);

    } catch (err) {
        try {
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(content);
            selection.removeAllRanges();
            selection.addRange(range);
            document.execCommand('copy');
            selection.removeAllRanges();
            alert("Đã sao chép nội dung!");
        } catch(e) {
            alert("Không thể tự động sao chép. Vui lòng bôi đen và nhấn Ctrl+C.");
        }
    }
}

// =========================================================================
// --- DOCX PROCESSING: DEEP RECURSIVE SCAN + FULL MATH PARSER ---
// =========================================================================
async function handleDownloadWord() {
    if(!window.generatedHTML) { alert("Chưa có nội dung!"); return; }
    if (typeof docx === 'undefined') { alert("Đang tải thư viện Word, vui lòng đợi 2 giây rồi bấm lại!"); return; }

    const btn = document.getElementById('btnDownloadWord');
    const oldText = btn.innerText;
    btn.innerText = "Đang tạo file..."; 
    btn.disabled = true;

    try {
        const { Document, Packer, Paragraph, Table, TableCell, TableRow, WidthType, TextRun, HeadingLevel, AlignmentType, BorderStyle, Math: DocxMath, MathRun, MathFraction, MathSuperScript, MathSubScript, MathRadical } = window.docx;

        // --- 1. FULL LATEX PARSER ---
        function parseLatexToDocx(latex) {
            const children = [];
            let i = 0;

            const symbolMap = {
                // Greek
                '\\alpha': 'α', '\\beta': 'β', '\\gamma': 'γ', '\\delta': 'δ', '\\epsilon': 'ε', '\\zeta': 'ζ',
                '\\eta': 'η', '\\theta': 'θ', '\\iota': 'ι', '\\kappa': 'κ', '\\lambda': 'λ', '\\mu': 'μ',
                '\\nu': 'ν', '\\xi': 'ξ', '\\pi': 'π', '\\rho': 'ρ', '\\sigma': 'σ', '\\tau': 'τ',
                '\\upsilon': 'υ', '\\phi': 'φ', '\\chi': 'χ', '\\psi': 'ψ', '\\omega': 'ω',
                '\\Delta': 'Δ', '\\Gamma': 'Γ', '\\Lambda': 'Λ', '\\Omega': 'Ω', '\\Phi': 'Φ', '\\Pi': 'Π', '\\Sigma': 'Σ',
                // Relations
                '\\approx': '≈', '\\neq': '≠', '\\ne': '≠', '\\leq': '≤', '\\le': '≤', '\\geq': '≥', '\\ge': '≥',
                '\\pm': '±', '\\mp': '∓', '\\equiv': '≡', '\\sim': '∼', '\\simeq': '≃',
                // Operators
                '\\times': '×', '\\div': '÷', '\\cdot': '·', '\\ast': '*', '\\star': '⋆', '\\oplus': '⊕', '\\otimes': '⊗',
                // Sets & Logic
                '\\in': '∈', '\\notin': '∉', '\\subset': '⊂', '\\supset': '⊃', '\\subseteq': '⊆', '\\supseteq': '⊇',
                '\\cup': '∪', '\\cap': '∩', '\\emptyset': '∅', '\\infty': '∞', '\\forall': '∀', '\\exists': '∃',
                '\\mathbb{R}': 'ℝ', '\\mathbb{N}': 'ℕ', '\\mathbb{Z}': 'ℤ', '\\mathbb{Q}': 'ℚ',
                // Arrows & Geometry
                '\\rightarrow': '→', '\\to': '→', '\\leftarrow': '←', '\\leftrightarrow': '↔', '\\Rightarrow': '⇒', '\\Leftrightarrow': '⇔',
                '\\angle': '∠', '\\triangle': '△', '\\perp': '⊥', '\\parallel': '∥', '\\degree': '°', '^\\circ': '°', 
                '\\%': '%', '\\$': '$', '\\{': '{', '\\}': '}'
            };

            while (i < latex.length) {
                const char = latex[i];
                if (char === '\\') {
                    let end = i + 1;
                    while (end < latex.length && /[a-zA-Z]/.test(latex[end])) end++;
                    if (end === i + 1 && end < latex.length) end++; 

                    const command = latex.substring(i, end);
                    let nextIdx = end;
                    while (nextIdx < latex.length && latex[nextIdx] === ' ') nextIdx++;

                    if (command === '\\frac') {
                        const num = extractGroup(latex, nextIdx);
                        const den = extractGroup(latex, num.nextIndex);
                        children.push(new MathFraction({ numerator: parseLatexToDocx(num.content), denominator: parseLatexToDocx(den.content) }));
                        i = den.nextIndex;
                    } 
                    else if (command === '\\sqrt') {
                        if (latex[nextIdx] === '[') {
                            const degree = extractGroup(latex, nextIdx, '[', ']');
                            const arg = extractGroup(latex, degree.nextIndex);
                            children.push(new MathRadical({ degree: parseLatexToDocx(degree.content), children: parseLatexToDocx(arg.content) }));
                            i = arg.nextIndex;
                        } else {
                            const arg = extractGroup(latex, nextIdx);
                            children.push(new MathRadical({ degree: [], children: parseLatexToDocx(arg.content) }));
                            i = arg.nextIndex;
                        }
                    }
                    else if (command === '\\text') {
                        const txt = extractGroup(latex, nextIdx);
                        children.push(new MathRun(txt.content));
                        i = txt.nextIndex;
                    }
                    else if (command === '\\mathbb') {
                        const grp = extractGroup(latex, nextIdx);
                        const key = `\\mathbb{${grp.content}}`;
                        children.push(new MathRun(symbolMap[key] || grp.content));
                        i = grp.nextIndex;
                    }
                    else if (['\\left', '\\right'].includes(command)) {
                        let bracket = latex[nextIdx];
                        children.push(new MathRun(bracket)); i = nextIdx + 1;
                    }
                    else if (symbolMap[command]) {
                        children.push(new MathRun(symbolMap[command])); i = nextIdx;
                    } 
                    else { i = nextIdx; }
                } 
                else if (char === '^') {
                    const prev = children.pop();
                    let content = "", nextIdx = i + 1;
                    if (latex[nextIdx] === '{') {
                        const grp = extractGroup(latex, nextIdx);
                        content = grp.content; nextIdx = grp.nextIndex;
                    } else { content = latex[nextIdx]; nextIdx++; }
                    if (prev) children.push(new MathSuperScript({ children: [prev], superScript: parseLatexToDocx(content) }));
                    else children.push(new MathSuperScript({ children: [new MathRun("")], superScript: parseLatexToDocx(content) }));
                    i = nextIdx;
                } 
                else if (char === '_') {
                    const prev = children.pop();
                    let content = "", nextIdx = i + 1;
                    if (latex[nextIdx] === '{') {
                        const grp = extractGroup(latex, nextIdx);
                        content = grp.content; nextIdx = grp.nextIndex;
                    } else { content = latex[nextIdx]; nextIdx++; }
                    if (prev) children.push(new MathSubScript({ children: [prev], subScript: parseLatexToDocx(content) }));
                    else children.push(new MathSubScript({ children: [new MathRun("")], subScript: parseLatexToDocx(content) }));
                    i = nextIdx;
                } 
                else if (char !== '{' && char !== '}') {
                    children.push(new MathRun(char)); i++;
                } 
                else { i++; }
            }
            return children;
        }

        function extractGroup(str, idx, open='{', close='}') {
            if (idx >= str.length) return {content:"", nextIndex:idx};
            if (str[idx] !== open) return {content:str[idx], nextIndex:idx+1};
            let depth=1, i=idx+1;
            while(i<str.length && depth>0) {
                if(str[i]===open) depth++; else if(str[i]===close) depth--;
                i++;
            }
            return {content:str.substring(idx+1, i-1), nextIndex:i};
        }

        // --- 2. RECURSIVE TEXT SCANNER (Fixes missing text issue) ---
        function getRunsFromNode(node, style = {}) {
            let runs = [];
            
            node.childNodes.forEach(child => {
                if (child.nodeType === 3) { // TEXT NODE
                    const text = child.nodeValue;
                    if (!text) return;
                    
                    const parts = text.split(/(\$\$[\s\S]*?\$\$)/g);
                    parts.forEach(part => {
                        if (part.startsWith('$$') && part.endsWith('$$')) {
                            const latex = part.slice(2, -2).trim();
                            runs.push(new DocxMath({ children: parseLatexToDocx(latex) }));
                        } else {
                            // Split by newline to preserve breaks
                            const lines = part.split('\n');
                            lines.forEach((line, index) => {
                                if (line) runs.push(new TextRun({ text: line, ...style }));
                                if (index < lines.length - 1) runs.push(new TextRun({ text: "", break: 1 }));
                            });
                        }
                    });
                } else if (child.nodeType === 1) { // ELEMENT NODE
                    const tag = child.tagName.toLowerCase();
                    
                    if (tag === 'br') {
                        runs.push(new TextRun({ text: "", break: 1 }));
                    } else {
                        const newStyle = { 
                            ...style, 
                            bold: style.bold || tag==='b' || tag==='strong', 
                            italics: style.italics || tag==='i' || tag==='em',
                            underline: style.underline || tag==='u'
                        };
                        // Recursive call for nested elements
                        runs.push(...getRunsFromNode(child, newStyle));
                    }
                }
            });
            return runs;
        }

        // --- 3. STATE MACHINE FLATTENER (Fixes Word corruption) ---
        const parser = new DOMParser();
        const docDOM = parser.parseFromString(`<div>${window.generatedHTML}</div>`, 'text/html');
        const root = docDOM.body.firstElementChild;
        
        const docChildren = []; 
        let currentParaRuns = []; 

        // Flush accumulated runs into a Paragraph
        function flushParagraph(opts = {}) {
            if (currentParaRuns.length > 0) {
                docChildren.push(new Paragraph({ 
                    children: [...currentParaRuns], 
                    ...opts,
                    spacing: { after: 100 }
                }));
                currentParaRuns = [];
            }
        }

        // Create Table Block
        function createTableBlock(tableNode) {
            const rows = Array.from(tableNode.querySelectorAll('tr')).map(tr => {
                const cells = Array.from(tr.querySelectorAll('td, th')).map(td => {
                    const isHeader = td.tagName.toLowerCase() === 'th';
                    const cellRuns = getRunsFromNode(td, { bold: isHeader });
                    
                    return new TableCell({
                        children: [new Paragraph({ 
                            children: cellRuns,
                            alignment: isHeader ? AlignmentType.CENTER : AlignmentType.LEFT
                        })],
                        columnSpan: parseInt(td.getAttribute('colspan') || 1),
                        rowSpan: parseInt(td.getAttribute('rowspan') || 1),
                        borders: {
                            top: {style: BorderStyle.SINGLE, size: 1},
                            bottom: {style: BorderStyle.SINGLE, size: 1},
                            left: {style: BorderStyle.SINGLE, size: 1},
                            right: {style: BorderStyle.SINGLE, size: 1},
                        },
                        width: { size: 100, type: WidthType.PERCENTAGE }
                    });
                });
                return new TableRow({ children: cells });
            });
            return new Table({ rows: rows, width: { size: 100, type: WidthType.PERCENTAGE } });
        }

        // Add Header
        docChildren.push(new Paragraph({
            text: "ĐỀ KIỂM TRA & MA TRẬN",
            heading: HeadingLevel.HEADING_1,
            alignment: AlignmentType.CENTER,
            spacing: { after: 300 }
        }));

        // Traverse DOM and Flatten
        function traverseAndFlatten(node) {
            if (node.nodeType === 1) { // Element
                const tag = node.tagName.toLowerCase();

                if (tag === 'table') {
                    flushParagraph(); 
                    docChildren.push(createTableBlock(node)); 
                    docChildren.push(new Paragraph("")); 
                } 
                else if (tag.match(/^h[1-6]$/)) {
                    flushParagraph();
                    const runs = getRunsFromNode(node, { bold: true });
                    docChildren.push(new Paragraph({
                        children: runs,
                        heading: HeadingLevel.HEADING_2,
                        spacing: { before: 200, after: 100 }
                    }));
                }
                else if (['p', 'div', 'li'].includes(tag)) {
                    flushParagraph();
                    // Check if block contains another block
                    const hasBlockChild = Array.from(node.children).some(c => ['div','p','table','h1','h2','h3'].includes(c.tagName.toLowerCase()));
                    
                    if (hasBlockChild) {
                        Array.from(node.childNodes).forEach(traverseAndFlatten);
                    } else {
                        const runs = getRunsFromNode(node);
                        if (runs.length > 0) {
                            docChildren.push(new Paragraph({ children: runs, spacing: { after: 50 } }));
                        }
                    }
                }
                else {
                    // Inline elements (span, b, i) -> Buffer
                    const runs = getRunsFromNode(node); 
                    currentParaRuns.push(...runs);
                }
            } 
            else if (node.nodeType === 3) { // Text Node at high level
                const runs = getRunsFromNode(node);
                currentParaRuns.push(...runs);
            }
        }

        Array.from(root.childNodes).forEach(traverseAndFlatten);
        flushParagraph(); 

        // 4. Create File
        const doc = new Document({ sections: [{ children: docChildren }] });
        const blob = await Packer.toBlob(doc);
        saveAs(blob, `De_Kiem_Tra_${Date.now()}.docx`);

    } catch(e) { 
        alert("Lỗi xuất file: " + e.message); console.error(e); 
    } finally { 
        btn.innerText = oldText; 
        btn.disabled = false; 
    }
}
