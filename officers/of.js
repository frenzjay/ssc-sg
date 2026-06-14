const API_URL = 'https://itzfrenz.7m.pl/calendar/studentGovApi.php?endpoint=officers';
let globalOfficers = [];

function getContrastTextColor(hex) {
   hex = hex.replace("#", "");
   if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
   const r = parseInt(hex.substring(0, 2), 16),
      g = parseInt(hex.substring(2, 4), 16),
      b = parseInt(hex.substring(4, 6), 16);
   return (((r * 299) + (g * 587) + (b * 114)) / 1000 >= 128) ? '#000000' : '#ffffff';
}

async function fetchOfficers() {
   try {
      const res = await fetch(API_URL);
      globalOfficers = await res.json();
      renderOrgChart();
   } catch (err) {
      document.getElementById('canvas').innerHTML = '<p class="alert error" style="margin:20px;">-1</p>';
   }
}

function renderOrgChart() {
   const canvas = document.getElementById('canvas');
   canvas.innerHTML = '';

   const grouped = {
      COLLEGE: {
         EXEC: [],
         DEPTS: {}
      },
      SHS: {
         EXEC: [],
         DEPTS: {}
      },
      JHS: {
         EXEC: [],
         DEPTS: {}
      }
   };

   globalOfficers.forEach(off => {
      const div = grouped[off.division];
      if (div) {
         if (!off.department || off.department.trim() === '') {
            div.EXEC.push(off);
         } else {
            const dept = off.department.trim();
            if (!div.DEPTS[dept]) div.DEPTS[dept] = [];
            div.DEPTS[dept].push(off);
         }
      }
   });

   function getPositionRank(position) {
      const pos = position.toLowerCase();
      if ((pos.includes('president') || pos.includes('governor') || pos.includes('mayor') || pos.includes('chairperson')) && !pos.includes('vice')) return 1;
      if (pos.includes('vice')) return 2;
      if (pos.includes('secretary')) return 3;
      if (pos.includes('treasurer')) return 4;
      if (pos.includes('auditor')) return 5;
      if (pos.includes('p.i.o') || pos.includes('pio')) return 6;
      if (pos.includes('representative') || pos.includes('rep')) {
         if (pos.includes('4th') || pos.includes('fourth')) return 7.1;
         if (pos.includes('3rd') || pos.includes('third')) return 7.2;
         if (pos.includes('2nd') || pos.includes('second')) return 7.3;
         if (pos.includes('1st') || pos.includes('first')) return 7.4;
         return 7.5;
      }
      return 99;
   }

   function sortOfficers(officersArray) {
      return officersArray.sort((a, b) => {
         const rankA = getPositionRank(a.position);
         const rankB = getPositionRank(b.position);
         if (rankA === rankB) return a.name.localeCompare(b.name);
         return rankA - rankB;
      });
   }

   function buildVerticalStack(officersList) {
      const heads = sortOfficers(officersList.filter(o => getPositionRank(o.position) === 1));
      const vices = sortOfficers(officersList.filter(o => getPositionRank(o.position) === 2));
      const execs = sortOfficers(officersList.filter(o => getPositionRank(o.position) >= 3 && getPositionRank(o.position) <= 6));
      const reps = sortOfficers(officersList.filter(o => getPositionRank(o.position) >= 7));

      let html = '<div class="vertical-stack">';

      function addTier(tierList) {
         let tierHtml = '<div class="org-tier">';
         tierList.forEach(off => {
            const textColor = getContrastTextColor(off.color);

            const hasCreds = off.credentials && off.credentials.trim() !== '';
            const cardClass = hasCreds ? 'officer-card has-creds' : 'officer-card';
            const clickEvent = hasCreds ? `onclick="openOfficer(${off.id})"` : '';
            const credsText = hasCreds ? `<p class="off-click">View Credentials</p>` : '';

            tierHtml += `
                            <div class="${cardClass}" style="border-bottom-color: ${off.color};" ${clickEvent}>
                                <div class="off-position" style="background-color: ${off.color}; color: ${textColor}; border-color: ${off.color};">
                                    ${off.position}
                                </div>
                                <h3 class="off-name">${off.name}</h3>
                                ${credsText}
                            </div>
                        `;
         });
         tierHtml += '</div>';
         return tierHtml;
      }

      [heads, vices, execs, reps].filter(t => t.length > 0).forEach(tier => html += addTier(tier));
      html += '</div>';
      return html;
   }

   function renderDivision(divTitle, data) {
      if (data.EXEC.length === 0 && Object.keys(data.DEPTS).length === 0) return '';

      let html = `<div style="display:flex; flex-direction:column; align-items:center; width: 100%;">`;
      html += `<h2 class="division-header">${divTitle}</h2>`;

      if (data.EXEC.length > 0) {
         html += `<div class="exec-title">OFFICERS</div>`;
         html += buildVerticalStack(data.EXEC);
      }

      const deptNames = Object.keys(data.DEPTS);
      if (deptNames.length > 0) {
         const hasParent = data.EXEC.length > 0 ? "has-parent" : "";
         html += `<div class="branch-container ${hasParent}">`;

         for (const dept of deptNames) {
            html += `<div class="branch-node">`;
            html += `  <div class="dept-title">${dept}</div>`;
            html += buildVerticalStack(data.DEPTS[dept]);
            html += `</div>`;
         }
         html += `</div>`;
      }
      html += `</div>`;
      return html;
   }

   let finalHtml = '';
   finalHtml += renderDivision('COLLEGE DIVISION', grouped.COLLEGE);
   finalHtml += renderDivision('SENIOR HIGH SCHOOL', grouped.SHS);
   finalHtml += renderDivision('JUNIOR HIGH SCHOOL', grouped.JHS);

   canvas.innerHTML = finalHtml;
   setTimeout(resetZoom, 50);
}
const viewport = document.getElementById('viewport');
const canvas = document.getElementById('canvas');

let scale = 1;
let currentX = 0;
let currentY = 0;

let isDragging = false;
let startX, startY;
let initialPinchDist = null;
let initialScale = 1;

function updateTransform() {
   canvas.style.transform = `translate(${currentX}px, ${currentY}px) scale(${scale})`;
}

function zoomIn() {
   scale *= 1.2;
   updateTransform();
}

function zoomOut() {
   scale /= 1.2;
   updateTransform();
}

function resetZoom() {
   let vW = viewport.clientWidth || window.innerWidth;
   let cW = canvas.scrollWidth || 1000;

   scale = vW / (cW + 80);
   if (isNaN(scale) || scale === Infinity) scale = 1;
   if (scale > 1) scale = 1;
   if (scale < 0.15) scale = 0.15;
   currentX = (vW - (cW * scale)) / 2;
   if (isNaN(currentX)) currentX = 0;

   currentY = 40;
   updateTransform();
}
viewport.addEventListener('mousedown', (e) => {
   isDragging = true;
   startX = e.clientX - currentX;
   startY = e.clientY - currentY;
   viewport.style.cursor = 'grabbing';
});

viewport.addEventListener('mousemove', (e) => {
   if (!isDragging) return;
   currentX = e.clientX - startX;
   currentY = e.clientY - startY;
   updateTransform();
});

viewport.addEventListener('mouseup', () => {
   isDragging = false;
   viewport.style.cursor = 'grab';
});
viewport.addEventListener('mouseleave', () => {
   isDragging = false;
   viewport.style.cursor = 'grab';
});

viewport.addEventListener('wheel', (e) => {
   e.preventDefault();
   if (e.deltaY < 0) zoomIn();
   else zoomOut();
}, {
   passive: false
});

viewport.addEventListener('touchstart', (e) => {
   if (e.touches.length === 1) {
      isDragging = true;
      startX = e.touches[0].clientX - currentX;
      startY = e.touches[0].clientY - currentY;
   } else if (e.touches.length === 2) {
      isDragging = false;
      initialPinchDist = Math.hypot(
         e.touches[0].clientX - e.touches[1].clientX,
         e.touches[0].clientY - e.touches[1].clientY
      );
      initialScale = scale;
   }
}, {
   passive: false
});

viewport.addEventListener('touchmove', (e) => {
   e.preventDefault();
   if (e.touches.length === 1 && isDragging) {
      currentX = e.touches[0].clientX - startX;
      currentY = e.touches[0].clientY - startY;
      updateTransform();
   } else if (e.touches.length === 2 && initialPinchDist) {
      const newDist = Math.hypot(
         e.touches[0].clientX - e.touches[1].clientX,
         e.touches[0].clientY - e.touches[1].clientY
      );
      scale = initialScale * (newDist / initialPinchDist);
      updateTransform();
   }
}, {
   passive: false
});

viewport.addEventListener('touchend', () => {
   isDragging = false;
   initialPinchDist = null;
});

function openOfficer(id) {
   const off = globalOfficers.find(o => o.id === id);
   if (!off) return;

   const safeCreds = DOMPurify.sanitize(marked.parse(off.credentials || 'No credentials provided.'));
   const textColor = getContrastTextColor(off.color);

   document.getElementById('modal-body').innerHTML = `
                <div class="badge" style="background-color: ${off.color}; color: ${textColor}; margin-bottom:15px; font-size:1rem;">${off.position}</div>
                <h2 style="margin-top: 0; font-size: 2rem; font-weight: 700; color: var(--ssc-black); text-transform: uppercase;">${off.name}</h2>
                <hr style="border: 2px dashed var(--ssc-black); margin: 15px 0;">
                <div class="markdown-content">${safeCreds}</div>
            `;

   document.getElementById('officer-modal').style.display = 'flex';
   document.body.style.overflow = 'hidden';
}

document.getElementById('close-modal').addEventListener('click', () => {
   document.getElementById('officer-modal').style.display = 'none';
   document.body.style.overflow = 'auto';
});

document.getElementById('officer-modal').addEventListener('click', (e) => {
   if (e.target === document.getElementById('officer-modal')) {
      document.getElementById('officer-modal').style.display = 'none';
      document.body.style.overflow = 'auto';
   }
});
fetchOfficers();