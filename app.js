const API_URL = 'http://itzfrenz.7m.pl/calendar/studentGovApi.php'; 

let globalData = [];
let isTimeline = true;
let currentDisplayDate = new Date(); 

marked.use({ breaks: true });

const purifyConfig = { ADD_TAGS: ['style'], ADD_ATTR: ['style', 'class', 'id'] };

function getContrastTextColor(hexcolor) {
    hexcolor = hexcolor.replace("#", "");
    if (hexcolor.length === 3) {
        hexcolor = hexcolor[0]+hexcolor[0]+hexcolor[1]+hexcolor[1]+hexcolor[2]+hexcolor[2];
    }
    const r = parseInt(hexcolor.substring(0,2), 16);
    const g = parseInt(hexcolor.substring(2,4), 16);
    const b = parseInt(hexcolor.substring(4,6), 16);
    const yiq = ((r*299) + (g*587) + (b*114)) / 1000;
    return (yiq >= 128) ? '#000000' : '#ffffff';
}

function parseSafeDate(dateString) {
    if (!dateString) return new Date(NaN);
    let isoStr = dateString.replace(' ', 'T');
    if (isoStr.includes('T') && isoStr.split(':').length === 2) isoStr += ':00';
    let d = new Date(isoStr);
    if (isNaN(d)) {
        let fallbackStr = isoStr.replace(/-/g, '/').replace('T', ' ');
        d = new Date(fallbackStr);
    }
    return d;
}
function formatDisplayDate(startStr, endStr, forTimeline) {
    const startDate = parseSafeDate(startStr);
    const dateOptions = forTimeline 
        ? { weekday: 'short', month: 'short', day: 'numeric' }
        : { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' };
    
    let result = startDate.toLocaleDateString('en-US', dateOptions);

    if (endStr) {
        const endDate = parseSafeDate(endStr);
        if (!isNaN(endDate)) {
            const endOptions = forTimeline ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'long', day: 'numeric' };
            result = `${startDate.toLocaleDateString('en-US', endOptions)} - ${endDate.toLocaleDateString('en-US', endOptions)}`;
        }
    }
    return result;
}

function updateTodayLabel() {
    const options = { timeZone: 'Asia/Manila', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' };
    const formatter = new Intl.DateTimeFormat('en-US', options);
    document.getElementById('today-label').innerText = `${formatter.format(new Date())}`;
}
setInterval(updateTodayLabel, 60000); 
updateTodayLabel(); 

document.getElementById('view-toggle').addEventListener('click', (e) => {
    isTimeline = !isTimeline;
    document.getElementById('timeline-view').style.display = isTimeline ? 'block' : 'none';
    document.getElementById('calendar-view').style.display = isTimeline ? 'none' : 'block';
    e.target.innerText = isTimeline ? 'CALENDAR' : 'TIMELINE';
});

function updateControlsUI() {
    const options = { month: 'long', year: 'numeric' };
    document.getElementById('current-month-year').innerText = currentDisplayDate.toLocaleDateString('en-US', options);
    renderTimeline();
    renderCalendar();
}

document.getElementById('btn-prev').addEventListener('click', () => { currentDisplayDate.setMonth(currentDisplayDate.getMonth() - 1); updateControlsUI(); });
document.getElementById('btn-next').addEventListener('click', () => { currentDisplayDate.setMonth(currentDisplayDate.getMonth() + 1); updateControlsUI(); });
document.getElementById('btn-today').addEventListener('click', () => { currentDisplayDate = new Date(); updateControlsUI(); });

document.getElementById('close-modal').addEventListener('click', () => { document.getElementById('post-modal').style.display = 'none'; document.body.style.overflow = 'auto'; });
document.getElementById('post-modal').addEventListener('click', (e) => {
    if(e.target === document.getElementById('post-modal')) {
        document.getElementById('post-modal').style.display = 'none';
        document.body.style.overflow = 'auto';
    }
});

function openPost(id) {
    const entry = globalData.find(e => e.id == id);
    if (!entry) return;

    const dateString = formatDisplayDate(entry.entry_date, entry.end_date, false);
    const rawMarkdown = entry.description || '-1';
    const safeHTML = DOMPurify.sanitize(marked.parse(rawMarkdown), purifyConfig);

    const catName = entry.category_name || entry.entry_type;
    const catColor = entry.category_color || '#000000';
    const textColor = getContrastTextColor(catColor);

    const modalBody = document.getElementById('modal-body');
    modalBody.innerHTML = `
        <div class="card-header">
            <div class="date">${dateString}</div>
            <div class="badge" style="background-color: ${catColor}; color: ${textColor};">${catName}</div>
        </div>
        <h2>${entry.title}</h2>
        <div class="markdown-content">
            ${safeHTML}
        </div>
    `;
    document.getElementById('post-modal').style.display = 'flex';
    document.body.style.overflow = 'hidden'; 
}

async function fetchEntries() {
    try {
        const response = await fetch(API_URL);
        if (!response.ok) throw new Error('-1');
        globalData = await response.json();
        updateControlsUI(); 
    } catch (error) {
        console.error("-1", error);
        document.getElementById('timeline-board').innerHTML = '<p style="border: 2px solid #000; background:red; color:white; padding:10px; font-weight: bold;">-1</p>';
    }
}

function renderTimeline() {
    const board = document.getElementById('timeline-board');
    board.innerHTML = ''; 

    const year = currentDisplayDate.getFullYear();
    const month = currentDisplayDate.getMonth();

    let monthData = globalData.filter(entry => {
        const entryDate = parseSafeDate(entry.entry_date);
        if (isNaN(entryDate)) return false;
        
        let spansIntoMonth = false;
        if (entry.end_date) {
            const endDate = parseSafeDate(entry.end_date);
            if (!isNaN(endDate)) {
                spansIntoMonth = (entryDate.getFullYear() <= year && endDate.getFullYear() >= year) &&
                                 (entryDate.getMonth() <= month && endDate.getMonth() >= month);
            }
        }
        
        return (entryDate.getFullYear() === year && entryDate.getMonth() === month) || spansIntoMonth;
    });

    monthData.sort((a, b) => parseSafeDate(b.entry_date) - parseSafeDate(a.entry_date));

    if (monthData.length === 0) {
        board.innerHTML = '<p style="border: 3px dashed #000; padding: 20px; text-align: center; font-weight: bold;">-1</p>';
        return;
    }

    monthData.forEach(entry => {
        const dateString = formatDisplayDate(entry.entry_date, entry.end_date, true);
        
        const catName = entry.category_name || entry.entry_type;
        const catColor = entry.category_color || '#000000';
        const textColor = getContrastTextColor(catColor);
        
        const hasContent = entry.description && entry.description.trim() !== '';

        const card = document.createElement('div');
        card.className = `card window-box`;
        card.style.borderTopColor = catColor;
        
        let safeHTML = '';
        let clickToReadHtml = '';

        if (hasContent) {
            safeHTML = DOMPurify.sanitize(marked.parse(entry.description), purifyConfig);
            card.classList.add('clickable');
            card.onclick = () => openPost(entry.id);
            clickToReadHtml = `<div style="margin-top: 20px; font-size: 0.9rem; font-weight: 700; color: #16a34a; border-top: 2px solid #000; padding-top: 10px;">[ CLICK TO READ ]</div>`;
        }
        
        card.innerHTML = `
            <div class="card-header">
                <div class="date">${dateString}</div>
                <div class="badge" style="background-color: ${catColor}; color: ${textColor};">${catName}</div>
            </div>
            <h3>${entry.title}</h3>
            ${hasContent ? `<div class="markdown-content markdown-preview">${safeHTML}</div>` : ''}
            ${clickToReadHtml}
        `;
        board.appendChild(card);
    });
}

function renderCalendar() {
    const grid = document.getElementById('calendar-grid');
    let calendarHtml = ''; 

    const year = currentDisplayDate.getFullYear();
    const month = currentDisplayDate.getMonth();
    const firstDayIndex = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    for (let i = 0; i < firstDayIndex; i++) { calendarHtml += `<div class="calendar-day empty"></div>`; }

    for (let day = 1; day <= daysInMonth; day++) {
        const currentCellDate = new Date(year, month, day, 0, 0, 0);
        
        const dayEntries = globalData.filter(entry => {
            const entryStartDate = parseSafeDate(entry.entry_date);
            if (isNaN(entryStartDate)) return false;
            
            const startDay = new Date(entryStartDate.getFullYear(), entryStartDate.getMonth(), entryStartDate.getDate(), 0, 0, 0);
            
            let endDay = startDay;
            if (entry.end_date) {
                const entryEndDate = parseSafeDate(entry.end_date);
                if (!isNaN(entryEndDate)) {
                    endDay = new Date(entryEndDate.getFullYear(), entryEndDate.getMonth(), entryEndDate.getDate(), 23, 59, 59);
                }
            }

            return currentCellDate >= startDay && currentCellDate <= endDay;
        });

        let eventsHtml = dayEntries.map(e => {
            const safeTitle = e.title ? e.title.replace(/<\/?[^>]+(>|$)/g, "") : 'Untitled';
            const catColor = e.category_color || '#000000';
            const textColor = getContrastTextColor(catColor);
            
            const hasContent = e.description && e.description.trim() !== '';

            if (hasContent) {
                return `<div class="cal-event clickable" onclick="openPost(${e.id})" style="background-color: ${catColor}; color: ${textColor};">${safeTitle}</div>`;
            } else {
                return `<div class="cal-event" style="background-color: ${catColor}; color: ${textColor};">${safeTitle}</div>`;
            }
        }).join('');

        calendarHtml += `<div class="calendar-day"><div class="day-number">${day}</div>${eventsHtml}</div>`;
    }
    grid.innerHTML = calendarHtml; 
}

fetchEntries();
