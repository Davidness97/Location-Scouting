(function () {
  const ELEMENTS_STORAGE_KEY = "villa_belloli_elements_v3";
  const CALIB_STORAGE_KEY = "villa_belloli_calib_v1";
  const DEFAULT_CALIB = { dNorth: 0.5, dEast: -1, rot: 6.5, scale: 1.14 };
  const isReadOnly = typeof READ_ONLY_MODE !== "undefined" && READ_ONLY_MODE === true;

  // State
  let showSatellite = true;
  let showPlan = true;
  let currentView = "satellite"; // derivato da showSatellite: "satellite" | activeFloor
  let activeFloor = "pt"; // "pt" | "p1" — unico selettore livello
  let activeFilters = new Set(["shooting", "stufa", "parking", "facilities", "streetview"]);
  let searchQuery = "";
  let selectedId = null;
  let activeDrawerTab = "gallery";
  let isEditingSpecs = false;
  let editMode = false;
  let pendingAdd = null; // { name, category, kw, floor }
  let currentMediaTargetId = null;

  // Map state
  let map = null;
  let overlayLayer = null;
  let markersLayer = null;
  let editBannerEl = null;
  let satOverlayOpacity = 1.0;
  let calib = loadCalib();

  // Lightbox state
  let lbPhotos = [];
  let lbIndex = 0;

  // Data
  let elements = loadElements();

  function loadElements() {
    if (!isReadOnly) {
      try {
        const saved = JSON.parse(localStorage.getItem(ELEMENTS_STORAGE_KEY) || "null");
        if (Array.isArray(saved) && saved.length > 0) return saved;
      } catch (e) {}
    }
    return JSON.parse(JSON.stringify(INITIAL_ELEMENTS));
  }

  function saveElements() {
    if (isReadOnly) return;
    try {
      localStorage.setItem(ELEMENTS_STORAGE_KEY, JSON.stringify(elements));
    } catch (e) {
      console.warn("Errore salvataggio localStorage:", e);
    }
  }

  function loadCalib() {
    if (!isReadOnly) {
      try {
        const saved = JSON.parse(localStorage.getItem(CALIB_STORAGE_KEY) || "null");
        if (saved && typeof saved.dNorth === "number") return saved;
      } catch (e) {}
    }
    return { ...DEFAULT_CALIB };
  }

  function saveCalibToStorage() {
    try {
      localStorage.setItem(CALIB_STORAGE_KEY, JSON.stringify(calib));
    } catch (e) {}
  }

  // Rotated ImageOverlay extension for Leaflet
  const RotatedImageOverlay = L.ImageOverlay.extend({
    options: { angle: 0 },
    setAngle(angle) {
      this.options.angle = angle;
      this._reset();
    },
    _animateZoom(e) {
      L.ImageOverlay.prototype._animateZoom.call(this, e);
      this._applyRotation();
    },
    _reset() {
      L.ImageOverlay.prototype._reset.call(this);
      this._applyRotation();
    },
    _applyRotation() {
      if (this._image) {
        this._image.style.transformOrigin = "center center";
        const base = this._image.style.transform.replace(/\s*rotate\([^)]*\)/g, "");
        this._image.style.transform = `${base} rotate(${this.options.angle || 0}deg)`;
      }
    }
  });

  function pxToLatLng(x, y) {
    return [VILLA_CONFIG.planHeight - y, x];
  }

  function latLngToPx(latlng) {
    return [Math.round(latlng.lng), Math.round(VILLA_CONFIG.planHeight - latlng.lat)];
  }

  // DOM refs
  const sidebarEl = document.getElementById("sidebar");
  const sidebarListEl = document.getElementById("sidebar-list");
  const searchInputEl = document.getElementById("search-input");
  const drawerEl = document.getElementById("drawer");
  const drawerBodyEl = document.getElementById("drawer-body");
  const satControlsEl = document.getElementById("sat-controls");
  const floorSwitcher = document.getElementById("floor-switcher");
  const btnToggleSat = document.getElementById("btn-toggle-sat");
  const btnTogglePlan = document.getElementById("btn-toggle-plan");

  // Su mobile la sidebar parte chiusa per lasciare spazio alla mappa
  if (window.innerWidth <= 820) {
    sidebarEl.classList.add("collapsed");
  }

  // Init
  if (isReadOnly) {
    document.querySelector(".topbar-actions").style.display = "none";
    satControlsEl.style.display = "none";
    document.getElementById("btn-toggle-calib").style.display = "none";
    document.getElementById("calib-panel").style.display = "none";
  }
  syncViewButtons();
  updateFilterCounts();
  renderMap();
  renderSidebar();
  bindEvents();

  function syncViewButtons() {
    currentView = showSatellite ? "satellite" : activeFloor;
    btnToggleSat.classList.toggle("active", showSatellite);
    btnTogglePlan.classList.toggle("active", showPlan);
    floorSwitcher.querySelectorAll(".level-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.floor === activeFloor);
    });
  }

  function bindEvents() {
    // Unico selettore livello (Piano Terra / Primo Piano)
    floorSwitcher.querySelectorAll(".level-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        setActiveFloor(btn.dataset.floor);
      });
    });

    // Due bottoni comodi On/Off per Satellite e Planimetria
    btnToggleSat.addEventListener("click", () => {
      if (showSatellite) {
        showSatellite = false;
        showPlan = true;
      } else {
        showSatellite = true;
      }
      syncViewButtons();
      renderMap();
    });

    btnTogglePlan.addEventListener("click", () => {
      if (showSatellite) {
        showPlan = !showPlan;
        syncViewButtons();
        updateSatOverlay();
      } else {
        // Se Satellite era spento, disattivare Planimetria riattiva Satellite
        showSatellite = true;
        showPlan = false;
        syncViewButtons();
        renderMap();
      }
    });

    // Filter pills
    document.querySelectorAll(".filter-pill").forEach((pill) => {
      pill.addEventListener("click", () => {
        const cat = pill.dataset.cat;
        if (activeFilters.has(cat)) {
          activeFilters.delete(cat);
          pill.classList.remove("active");
        } else {
          activeFilters.add(cat);
          pill.classList.add("active");
        }
        renderMapLayers();
        renderSidebar();
      });
    });

    // Presets
    document.getElementById("preset-all").addEventListener("click", () => {
      setFilterPreset(["shooting", "stufa", "parking", "facilities", "streetview"]);
    });
    document.getElementById("preset-shooting").addEventListener("click", () => {
      setFilterPreset(["shooting", "stufa"]);
    });
    document.getElementById("preset-logistics").addEventListener("click", () => {
      setFilterPreset(["parking", "stufa", "facilities", "streetview"]);
    });

    // Search
    searchInputEl.addEventListener("input", (e) => {
      searchQuery = e.target.value.trim().toLowerCase();
      renderSidebar();
    });

    // Sidebar toggle & close
    document.getElementById("btn-toggle-sidebar").addEventListener("click", () => {
      sidebarEl.classList.toggle("collapsed");
      setTimeout(() => map && map.invalidateSize(), 220);
    });
    document.getElementById("btn-close-sidebar").addEventListener("click", () => {
      sidebarEl.classList.add("collapsed");
      setTimeout(() => map && map.invalidateSize(), 220);
    });

    // Edit Mode (drag symbols)
    const btnEditMode = document.getElementById("btn-edit-mode");
    btnEditMode.addEventListener("click", () => {
      editMode = !editMode;
      btnEditMode.classList.toggle("active", editMode);
      updateEditBanner();
      renderMapLayers();
    });

    // Add Point Modal
    const addModal = document.getElementById("add-modal");
    const addCat = document.getElementById("add-category");
    const addKwWrap = document.getElementById("add-kw-wrap");
    addCat.addEventListener("change", () => {
      addKwWrap.style.display = addCat.value === "stufa" ? "flex" : "none";
    });

    document.getElementById("btn-add-point").addEventListener("click", () => {
      document.getElementById("add-name").value = "";
      document.getElementById("add-floor").value = activeFloor;
      addKwWrap.style.display = addCat.value === "stufa" ? "flex" : "none";
      addModal.classList.add("open");
    });

    document.getElementById("btn-add-cancel").addEventListener("click", () => {
      addModal.classList.remove("open");
    });

    document.getElementById("btn-add-confirm").addEventListener("click", () => {
      const cat = addCat.value;
      const kw = cat === "stufa" ? Number(document.getElementById("add-kw").value) : undefined;
      const rawName = document.getElementById("add-name").value.trim();
      const name = rawName || (cat === "stufa" ? `Stufa ${kw} kW` : CATEGORIES[cat].label);
      const floor = document.getElementById("add-floor").value;

      pendingAdd = { name, category: cat, kw, floor };
      addModal.classList.remove("open");

      if (activeFloor !== floor) {
        setActiveFloor(floor);
      }
      if (!activeFilters.has(cat)) {
        activeFilters.add(cat);
        document.querySelector(`.filter-pill[data-cat="${cat}"]`)?.classList.add("active");
      }
      updateEditBanner();
    });

    // Manual calibration controls
    const btnToggleCalib = document.getElementById("btn-toggle-calib");
    const calibPanel = document.getElementById("calib-panel");
    const cNorth = document.getElementById("calib-north");
    const cEast = document.getElementById("calib-east");
    const cRot = document.getElementById("calib-rot");
    const cScale = document.getElementById("calib-scale");

    function syncCalibUI() {
      cNorth.value = calib.dNorth;
      cEast.value = calib.dEast;
      cRot.value = calib.rot;
      cScale.value = Math.round(calib.scale * 100);
      document.getElementById("calib-north-val").textContent = `${calib.dNorth} m`;
      document.getElementById("calib-east-val").textContent = `${calib.dEast} m`;
      document.getElementById("calib-rot-val").textContent = `${calib.rot}°`;
      document.getElementById("calib-scale-val").textContent = `${Math.round(calib.scale * 100)}%`;
    }
    syncCalibUI();

    btnToggleCalib.addEventListener("click", () => {
      const opening = calibPanel.style.display === "none";
      calibPanel.style.display = opening ? "flex" : "none";
      if (opening && !showPlan) {
        showPlan = true;
        syncViewButtons();
        updateSatOverlay();
      }
    });

    function onCalibInput() {
      calib.dNorth = Number(cNorth.value);
      calib.dEast = Number(cEast.value);
      calib.rot = Number(cRot.value);
      calib.scale = Number(cScale.value) / 100;
      syncCalibUI();
      if (overlayLayer) {
        overlayLayer.setBounds(getCalibratedOverlayBounds());
        overlayLayer.setAngle(calib.rot);
      }
      renderMapLayers();
    }

    [cNorth, cEast, cRot, cScale].forEach((el) => el.addEventListener("input", onCalibInput));

    document.getElementById("btn-calib-reset").addEventListener("click", () => {
      calib = { ...DEFAULT_CALIB };
      saveCalibToStorage();
      syncCalibUI();
      if (overlayLayer) {
        overlayLayer.setBounds(getCalibratedOverlayBounds());
        overlayLayer.setAngle(calib.rot);
      }
      renderMapLayers();
    });

    document.getElementById("btn-calib-save").addEventListener("click", () => {
      saveCalibToStorage();
      const btn = document.getElementById("btn-calib-save");
      btn.textContent = "✓ Salvato!";
      setTimeout(() => (btn.textContent = "💾 Salva"), 1400);
    });

    // Drawer close & tabs
    document.getElementById("btn-close-drawer").addEventListener("click", closeDrawer);
    document.querySelectorAll(".drawer-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        activeDrawerTab = tab.dataset.tab;
        isEditingSpecs = false;
        document.querySelectorAll(".drawer-tab").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        renderDrawerBody();
      });
    });

    // Media Picker Modal
    document.getElementById("btn-media-close").addEventListener("click", () => {
      document.getElementById("media-modal").classList.remove("open");
    });
    document.getElementById("btn-media-done").addEventListener("click", () => {
      document.getElementById("media-modal").classList.remove("open");
    });

    // Upload photos or videos from PC
    document.getElementById("input-upload-photo").addEventListener("change", (e) => {
      const el = elements.find((x) => x.id === currentMediaTargetId);
      if (!el) return;
      const files = Array.from(e.target.files || []);
      files.forEach((file) => {
        if (file.type.startsWith("video/") || /\.(mp4|mov|webm|m4v)$/i.test(file.name)) {
          const blobUrl = URL.createObjectURL(file);
          el.videos = el.videos || [];
          el.videos.push({ src: blobUrl, name: file.name });
          saveElements();
          renderGalleryTab(el);
          renderSidebar();
          openMediaPicker(el);
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const img = new Image();
          img.onload = () => {
            const maxDim = 1600;
            let w = img.width, h = img.height;
            if (w > maxDim || h > maxDim) {
              const r = Math.min(maxDim / w, maxDim / h);
              w = Math.round(w * r);
              h = Math.round(h * r);
            }
            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            canvas.getContext("2d").drawImage(img, 0, 0, w, h);
            const dataUrl = canvas.toDataURL("image/jpeg", 0.84);
            el.photos = el.photos || [];
            el.photos.push({ src: dataUrl, name: file.name });
            saveElements();
            renderGalleryTab(el);
            renderSidebar();
            openMediaPicker(el);
          };
          img.src = reader.result;
        };
        reader.readAsDataURL(file);
      });
      e.target.value = "";
    });

    // Add external URL or local filename
    function addExternalMedia() {
      const el = elements.find((x) => x.id === currentMediaTargetId);
      const inp = document.getElementById("input-ext-media");
      const val = inp.value.trim();
      if (!el || !val) return;
      const isVideo = /\.(mp4|mov|webm|m4v)(\?.*)?$/i.test(val);
      if (isVideo) {
        el.videos = el.videos || [];
        if (!el.videos.some((v) => (typeof v === "string" ? v : v.src) === val)) {
          el.videos.push(val);
        }
      } else {
        el.photos = el.photos || [];
        if (!el.photos.some((p) => (typeof p === "string" ? p : p.src) === val)) {
          el.photos.push(val);
        }
      }
      inp.value = "";
      saveElements();
      renderGalleryTab(el);
      renderSidebar();
      openMediaPicker(el);
    }

    document.getElementById("btn-add-ext-media").addEventListener("click", addExternalMedia);
    document.getElementById("input-ext-media").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addExternalMedia();
      }
    });

    // Lightbox
    document.getElementById("lb-close").addEventListener("click", closeLightbox);
    document.getElementById("lb-prev").addEventListener("click", () => stepLightbox(-1));
    document.getElementById("lb-next").addEventListener("click", () => stepLightbox(1));
    document.getElementById("lightbox").addEventListener("click", (e) => {
      if (e.target.id === "lightbox") closeLightbox();
    });

    // Keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (pendingAdd) {
          pendingAdd = null;
          updateEditBanner();
        } else if (document.getElementById("media-modal").classList.contains("open")) {
          document.getElementById("media-modal").classList.remove("open");
        } else if (document.getElementById("add-modal").classList.contains("open")) {
          document.getElementById("add-modal").classList.remove("open");
        } else if (document.getElementById("lightbox").classList.contains("open")) {
          closeLightbox();
        } else {
          closeDrawer();
        }
      } else if (document.getElementById("lightbox").classList.contains("open")) {
        if (e.key === "ArrowLeft") stepLightbox(-1);
        if (e.key === "ArrowRight") stepLightbox(1);
      }
    });

    // Export / Import JSON
    document.getElementById("btn-export").addEventListener("click", exportJSON);
    document.getElementById("input-import").addEventListener("change", importJSON);
  }

  function updateEditBanner() {
    if (!editBannerEl) {
      editBannerEl = document.createElement("div");
      editBannerEl.className = "edit-banner";
      document.querySelector(".map-stage").appendChild(editBannerEl);
    }
    if (pendingAdd) {
      editBannerEl.textContent = `📍 Clicca sulla mappa per posizionare "${pendingAdd.name}" (Esc per annullare)`;
      editBannerEl.style.display = "block";
    } else if (editMode) {
      editBannerEl.textContent = "✏️ Modalità Spostamento attiva: trascina i simboli per riposizionarli";
      editBannerEl.style.display = "block";
    } else {
      editBannerEl.style.display = "none";
    }
  }

  function setActiveFloor(floor) {
    activeFloor = floor;
    syncViewButtons();
    if (showSatellite) {
      updateSatOverlay();
      updateFilterCounts();
      renderMapLayers();
    } else {
      renderMap();
      updateFilterCounts();
    }
    renderSidebar();
    updateHeaterSummary();
  }

  function setFilterPreset(cats) {
    activeFilters = new Set(cats);
    document.querySelectorAll(".filter-pill").forEach((p) => {
      p.classList.toggle("active", activeFilters.has(p.dataset.cat));
    });
    renderMapLayers();
    renderSidebar();
  }

  function updateFilterCounts() {
    const counts = { shooting: 0, stufa: 0, parking: 0, facilities: 0, streetview: 0 };
    elements.forEach((el) => {
      if (el.floor !== activeFloor) return;
      if (counts[el.category] !== undefined) counts[el.category]++;
    });
    Object.keys(counts).forEach((k) => {
      const node = document.getElementById(`cnt-${k}`);
      if (node) node.textContent = counts[k];
    });
  }

  function updateHeaterSummary() {
    const relevant = elements.filter((e) => e.category === "stufa" && e.floor === activeFloor);
    const totalKw = relevant.reduce((sum, h) => sum + (Number(h.kw) || 0), 0);
    const c3 = relevant.filter((h) => Number(h.kw) === 3).length;
    const c5 = relevant.filter((h) => Number(h.kw) === 5).length;
    const c9 = relevant.filter((h) => Number(h.kw) === 9).length;
    document.getElementById("heater-total-kw").textContent = `${totalKw} kW`;
    document.querySelector(".heater-legend").innerHTML = `
      <span class="heater-chip"><span class="heater-swatch" style="background:#1d4ed8"></span> 3 kW (×${c3})</span>
      <span class="heater-chip"><span class="heater-swatch" style="background:#06b6d4"></span> 5 kW (×${c5})</span>
      <span class="heater-chip"><span class="heater-swatch" style="background:#ef4444"></span> 9 kW (×${c9})</span>
    `;
  }

  // ==================== CALIBRATION MATH ====================
  function getOverlayCenter() {
    const [[s, w], [n, e]] = VILLA_CONFIG.defaultOverlayBounds;
    return [(s + n) / 2, (w + e) / 2];
  }

  function getCalibratedOverlayBounds() {
    const [[s, w], [n, e]] = VILLA_CONFIG.defaultOverlayBounds;
    const [cLat, cLng] = getOverlayCenter();
    const mPerDegLat = 111320;
    const mPerDegLng = 111320 * Math.cos((cLat * Math.PI) / 180);
    const dLat = calib.dNorth / mPerDegLat;
    const dLng = calib.dEast / mPerDegLng;
    const halfH = ((n - s) / 2) * calib.scale;
    const halfW = ((e - w) / 2) * calib.scale;
    return [
      [cLat + dLat - halfH, cLng + dLng - halfW],
      [cLat + dLat + halfH, cLng + dLng + halfW]
    ];
  }

  function applyCalibToLatLng([lat, lng]) {
    if (calib.dNorth === 0 && calib.dEast === 0 && calib.rot === 0 && calib.scale === 1) {
      return [lat, lng];
    }
    const [cLat, cLng] = getOverlayCenter();
    const mPerDegLat = 111320;
    const mPerDegLng = 111320 * Math.cos((cLat * Math.PI) / 180);
    const x = (lng - cLng) * mPerDegLng * calib.scale;
    const y = (lat - cLat) * mPerDegLat * calib.scale;
    const rad = (-calib.rot * Math.PI) / 180;
    const rx = x * Math.cos(rad) - y * Math.sin(rad);
    const ry = x * Math.sin(rad) + y * Math.cos(rad);
    return [
      cLat + (ry + calib.dNorth) / mPerDegLat,
      cLng + (rx + calib.dEast) / mPerDegLng
    ];
  }

  function unapplyCalibFromLatLng([lat, lng]) {
    if (calib.dNorth === 0 && calib.dEast === 0 && calib.rot === 0 && calib.scale === 1) {
      return [lat, lng];
    }
    const [cLat, cLng] = getOverlayCenter();
    const mPerDegLat = 111320;
    const mPerDegLng = 111320 * Math.cos((cLat * Math.PI) / 180);
    const rx = (lng - cLng) * mPerDegLng - calib.dEast;
    const ry = (lat - cLat) * mPerDegLat - calib.dNorth;
    const rad = (calib.rot * Math.PI) / 180;
    const x = (rx * Math.cos(rad) - ry * Math.sin(rad)) / calib.scale;
    const y = (rx * Math.sin(rad) + ry * Math.cos(rad)) / calib.scale;
    return [cLat + y / mPerDegLat, cLng + x / mPerDegLng];
  }

  // ==================== LEAFLET MAP ENGINE ====================
  function renderMap() {
    if (map) {
      map.remove();
      map = null;
      overlayLayer = null;
      markersLayer = null;
    }

    if (currentView === "satellite") {
      if (!isReadOnly) satControlsEl.classList.add("visible");
      map = L.map("map", {
        center: VILLA_CONFIG.satelliteCenter,
        zoom: VILLA_CONFIG.satelliteZoom,
        maxZoom: 21,
        zoomControl: true
      });

      const googleHybrid = L.tileLayer("https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}", {
        maxZoom: 21,
        attribution: "Google Satellite"
      });
      const esriSat = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: 20,
        attribution: "Esri World Imagery"
      });
      const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "OpenStreetMap"
      });

      googleHybrid.addTo(map);
      L.control.layers(
        { "🛰️ Google Satellite": googleHybrid, "🌍 Esri Satellite": esriSat, "🗺️ Mappa Stradale": osm },
        {},
        { position: "bottomright" }
      ).addTo(map);

      updateSatOverlay();
    } else {
      satControlsEl.classList.remove("visible");
      const w = VILLA_CONFIG.planWidth;
      const h = VILLA_CONFIG.planHeight;
      const bounds = [[0, 0], [h, w]];

      map = L.map("map", {
        crs: L.CRS.Simple,
        minZoom: -2,
        maxZoom: 2,
        zoomSnap: 0.25,
        attributionControl: false
      });

      const imgSrc = currentView === "pt"
        ? "assets/plans/piano-terra.png"
        : "assets/plans/primo-piano.png";

      L.imageOverlay(imgSrc, bounds).addTo(map);
      map.fitBounds(bounds);
    }

    // Handle click-to-place new element
    map.on("click", (e) => {
      if (!pendingAdd) return;
      const newId = `el-${Date.now()}`;
      const isSat = currentView === "satellite";
      const satCoords = isSat
        ? unapplyCalibFromLatLng([e.latlng.lat, e.latlng.lng])
        : VILLA_CONFIG.satelliteCenter;
      const planCoords = isSat
        ? [1800, 1200]
        : latLngToPx(e.latlng);

      const newEl = {
        id: newId,
        name: pendingAdd.name,
        floor: pendingAdd.floor,
        category: pendingAdd.category,
        kw: pendingAdd.kw,
        pin: planCoords,
        satLatLng: satCoords,
        photos: [],
        videos: [],
        specs: { dimensioni: "", altezzaPavimento: "", esposizione: "", caratteristiche: "", noteProduzione: "" }
      };
      elements.push(newEl);
      saveElements();
      pendingAdd = null;
      updateEditBanner();
      updateFilterCounts();
      updateHeaterSummary();
      renderMapLayers();
      renderSidebar();
      selectLocation(newId);
    });

    markersLayer = L.layerGroup().addTo(map);
    renderMapLayers();
    updateHeaterSummary();
  }

  function updateSatOverlay() {
    if (!map || !showSatellite) return;
    if (overlayLayer) {
      map.removeLayer(overlayLayer);
      overlayLayer = null;
    }
    if (!showPlan) return;
    const imgSrc = activeFloor === "pt"
      ? "assets/plans/piano-terra-sat.png"
      : "assets/plans/primo-piano-sat.png";
    overlayLayer = new RotatedImageOverlay(imgSrc, getCalibratedOverlayBounds(), {
      opacity: satOverlayOpacity,
      interactive: false,
      angle: calib.rot
    }).addTo(map);
  }

  function renderMapLayers() {
    if (!markersLayer) return;
    markersLayer.clearLayers();

    const isSat = currentView === "satellite";

    elements.forEach((el) => {
      // Mostra SOLO gli elementi del livello attivo e delle categorie filtrate
      if (el.floor !== activeFloor) return;
      if (!activeFilters.has(el.category)) return;

      const catInfo = CATEGORIES[el.category] || CATEGORIES.facilities;

      // Poligono per le stanze shooting
      if (isSat && el.satPolygon && el.satPolygon.length >= 3) {
        const poly = L.polygon(el.satPolygon.map(applyCalibToLatLng), {
          color: catInfo.color,
          weight: selectedId === el.id ? 3 : 2,
          fillColor: catInfo.color,
          fillOpacity: selectedId === el.id ? 0.34 : 0.16
        });
        poly.bindTooltip(`${catInfo.icon} ${el.name}`, { sticky: true, className: "room-label-tooltip" });
        poly.on("click", () => !pendingAdd && selectLocation(el.id));
        poly.addTo(markersLayer);
      } else if (!isSat && el.polygon && el.polygon.length >= 3) {
        const poly = L.polygon(el.polygon.map(([x, y]) => pxToLatLng(x, y)), {
          color: catInfo.color,
          weight: selectedId === el.id ? 4 : 2,
          fillColor: catInfo.color,
          fillOpacity: selectedId === el.id ? 0.34 : 0.16
        });
        poly.bindTooltip(`${catInfo.icon} ${el.name}`, { sticky: true, className: "room-label-tooltip" });
        poly.on("click", () => !pendingAdd && selectLocation(el.id));
        poly.addTo(markersLayer);
      }

      // Marker / Badge
      let markerIcon;
      if (el.category === "stufa") {
        const kw = Number(el.kw) || 3;
        const bg = kw === 9 ? "#ef4444" : kw === 5 ? "#06b6d4" : "#1d4ed8";
        markerIcon = L.divIcon({
          className: "",
          html: `<div class="stufa-badge" style="background:${bg};${isSat ? "font-size:9px;padding:1px 4px;" : ""}">🔥 ${kw}kW</div>`,
          iconSize: isSat ? [42, 18] : [52, 22],
          iconAnchor: isSat ? [21, 9] : [26, 11]
        });
      } else {
        const size = isSat ? 24 : 28;
        markerIcon = L.divIcon({
          className: "",
          html: `<div class="custom-pin" style="width:${size}px;height:${size}px;font-size:${isSat ? 11 : 12}px;background:${catInfo.color};${editMode ? "cursor:grab;" : ""}">${catInfo.icon}</div>`,
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2]
        });
      }

      const pos = isSat
        ? applyCalibToLatLng(el.satLatLng || VILLA_CONFIG.satelliteCenter)
        : pxToLatLng(...(el.pin || [1800, 1200]));

      const m = L.marker(pos, { icon: markerIcon, draggable: editMode });
      m.bindTooltip(el.name, { direction: "top", className: "room-label-tooltip" });
      m.on("click", () => {
        if (!pendingAdd) selectLocation(el.id);
      });
      if (editMode) {
        m.on("dragend", (ev) => {
          const ll = ev.target.getLatLng();
          if (isSat) {
            el.satLatLng = unapplyCalibFromLatLng([ll.lat, ll.lng]);
          } else {
            el.pin = latLngToPx(ll);
          }
          saveElements();
        });
      }
      m.addTo(markersLayer);
    });
  }

  // ==================== SIDEBAR ====================
  function renderSidebar() {
    sidebarListEl.innerHTML = "";
    // Nella lista laterale NON compaiono le stufe (restano solo sulla mappa!)
    const filtered = elements.filter((el) => {
      if (el.category === "stufa") return false;
      if (el.floor !== activeFloor) return false;
      if (!activeFilters.has(el.category)) return false;
      if (searchQuery) {
        const hay = `${el.name} ${Object.values(el.specs || {}).join(" ")}`.toLowerCase();
        if (!hay.includes(searchQuery)) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-media";
      empty.textContent = "Nessun elemento su questo livello.";
      sidebarListEl.appendChild(empty);
      return;
    }

    // Organizza gli elementi per categoria
    const catOrder = ["shooting", "parking", "facilities", "streetview"];
    catOrder.forEach((catKey) => {
      const items = filtered.filter((el) => el.category === catKey);
      if (items.length === 0) return;

      const cat = CATEGORIES[catKey] || CATEGORIES.facilities;
      const header = document.createElement("div");
      header.className = "list-section-title";
      header.textContent = `${cat.icon} ${cat.label} (${items.length})`;
      sidebarListEl.appendChild(header);

      items.forEach((el) => {
        const card = document.createElement("div");
        card.className = `list-item${selectedId === el.id ? " selected" : ""}`;
        const mediaCount = (el.photos?.length || 0) + (el.videos?.length || 0);
        card.innerHTML = `
          <span class="list-item-badge" style="background:${cat.color}"></span>
          <div class="list-item-body">
            <div class="list-item-title">${escapeHtml(el.name)}</div>
            <div class="list-item-sub">
              <span>${el.floor === "pt" ? "Piano Terra" : "Primo Piano"}</span>
              ${mediaCount > 0 ? `<span>📷 ${el.photos.length} • 🎥 ${el.videos.length}</span>` : ""}
            </div>
          </div>
        `;
        card.addEventListener("click", () => {
          if (window.innerWidth <= 820) {
            sidebarEl.classList.add("collapsed");
          }
          selectLocation(el.id, true);
        });
        sidebarListEl.appendChild(card);
      });
    });
  }

  // ==================== SELECTION & DRAWER ====================
  function selectLocation(id, panTo = false) {
    selectedId = id;
    const el = elements.find((x) => x.id === id);
    if (!el) return;

    renderSidebar();
    renderMapLayers();

    if (panTo && map) {
      if (currentView === "satellite") {
        map.setView(applyCalibToLatLng(el.satLatLng || VILLA_CONFIG.satelliteCenter), Math.max(map.getZoom(), 20), { animate: true });
      } else if (el.pin) {
        map.setView(pxToLatLng(el.pin[0], el.pin[1]), 0.5, { animate: true });
      }
    }

    const cat = CATEGORIES[el.category] || CATEGORIES.facilities;
    const tagEl = document.getElementById("drawer-tag");
    tagEl.textContent = `${cat.icon} ${cat.label} • ${el.floor === "pt" ? "Piano Terra" : "Primo Piano"}`;
    tagEl.style.background = `${cat.color}33`;
    tagEl.style.color = "#fff";
    tagEl.style.border = `1px solid ${cat.color}`;

    document.getElementById("drawer-title").textContent = el.name;
    document.getElementById("drawer-subtitle").textContent = "";

    isEditingSpecs = false;
    drawerEl.classList.add("open");
    renderDrawerBody();
  }

  function closeDrawer() {
    drawerEl.classList.remove("open");
    selectedId = null;
    renderSidebar();
    renderMapLayers();
  }

  function renderDrawerBody() {
    const el = elements.find((x) => x.id === selectedId);
    if (!el) return;

    if (activeDrawerTab === "gallery") {
      renderGalleryTab(el);
    } else {
      renderSpecsTab(el);
    }
  }

  function renderGalleryTab(el) {
    const photos = el.photos || [];
    const videos = el.videos || [];

    let html = isReadOnly ? "" : `
      <div class="spec-actions">
        <button class="btn-primary" id="btn-assign-media">➕ Assegna Foto / Video</button>
      </div>
    `;

    if (photos.length === 0 && videos.length === 0) {
      html += `<div class="empty-media">Nessun file assegnato${isReadOnly ? "." : ". Clicca <strong>➕ Assegna Foto / Video</strong> per collegare foto o video a questa zona."}</div>`;
    } else {
      if (photos.length > 0) {
        html += `<div class="media-section-title">📸 Foto (${photos.length})</div><div class="photo-grid">`;
        photos.forEach((p, idx) => {
          const src = typeof p === "string" ? p : p.src;
          html += `
            <div class="photo-card" data-photo-idx="${idx}">
              ${isReadOnly ? "" : `<button class="media-remove-btn" data-remove-photo="${idx}" title="Rimuovi foto dalla zona">✕</button>`}
              <img src="${src}" alt="${src}" loading="lazy" />
            </div>
          `;
        });
        html += `</div>`;
      }
      if (videos.length > 0) {
        html += `<div class="media-section-title">🎥 Video (${videos.length})</div><div class="video-list">`;
        videos.forEach((v, idx) => {
          const src = typeof v === "string" ? v : v.src;
          const label = (typeof v === "object" && v.name) ? v.name : src.split("/").pop();
          const safeSrc = src.startsWith("blob:") || src.startsWith("data:") ? src : encodeURI(src);
          html += `
            <div class="video-card">
              <video controls playsinline preload="metadata" src="${safeSrc}"></video>
              <div class="video-card-footer">
                <span class="video-card-label" style="padding:0;">${escapeHtml(label)}</span>
                ${isReadOnly ? "" : `<button class="video-remove-btn" data-remove-video="${idx}" title="Rimuovi video dalla zona">✕ Rimuovi</button>`}
              </div>
            </div>
          `;
        });
        html += `</div>`;
      }
    }

    drawerBodyEl.innerHTML = html;

    const btnAssign = document.getElementById("btn-assign-media");
    if (btnAssign) btnAssign.addEventListener("click", () => openMediaPicker(el));

    drawerBodyEl.querySelectorAll("[data-remove-photo]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        el.photos.splice(Number(btn.dataset.removePhoto), 1);
        saveElements();
        renderGalleryTab(el);
        renderSidebar();
      });
    });

    drawerBodyEl.querySelectorAll("[data-remove-video]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        el.videos.splice(Number(btn.dataset.removeVideo), 1);
        saveElements();
        renderGalleryTab(el);
        renderSidebar();
      });
    });

    drawerBodyEl.querySelectorAll(".photo-card").forEach((card) => {
      card.addEventListener("click", () => {
        openLightbox(photos.map((p) => (typeof p === "string" ? p : p.src)), Number(card.dataset.photoIdx));
      });
    });
  }

  function openMediaPicker(el) {
    currentMediaTargetId = el.id;
    const grid = document.getElementById("media-picker-grid");
    grid.innerHTML = "";
    el.photos = el.photos || [];
    el.videos = el.videos || [];

    // Mostra anche eventuali foto personalizzate/esterne già assegnate a questa zona
    const customPhotos = el.photos.filter((p) => {
      const s = typeof p === "string" ? p : p.src;
      return !ALL_MEDIA.photos.includes(s);
    });

    customPhotos.forEach((p) => {
      const src = typeof p === "string" ? p : p.src;
      const label = (typeof p === "object" && p.name) ? p.name : src.split("/").pop();
      const item = document.createElement("div");
      item.className = "media-pick-item picked";
      item.innerHTML = `
        <img src="${src}" loading="lazy" />
        <span class="media-pick-badge">✓</span>
        <span class="media-pick-name">${escapeHtml(label)}</span>
      `;
      item.addEventListener("click", () => {
        const idx = el.photos.findIndex((x) => (typeof x === "string" ? x : x.src) === src);
        if (idx >= 0) el.photos.splice(idx, 1);
        saveElements();
        renderGalleryTab(el);
        renderSidebar();
        openMediaPicker(el);
      });
      grid.appendChild(item);
    });

    const customVideos = el.videos.filter((v) => {
      const s = typeof v === "string" ? v : v.src;
      return !ALL_MEDIA.videos.includes(s);
    });

    customVideos.forEach((v) => {
      const src = typeof v === "string" ? v : v.src;
      const label = (typeof v === "object" && v.name) ? v.name : src.split("/").pop();
      const item = document.createElement("div");
      item.className = "media-pick-item picked";
      item.innerHTML = `
        <div style="font-size:28px;">🎥</div>
        <span class="media-pick-badge">✓</span>
        <span class="media-pick-name">${escapeHtml(label)}</span>
      `;
      item.addEventListener("click", () => {
        const idx = el.videos.findIndex((x) => (typeof x === "string" ? x : x.src) === src);
        if (idx >= 0) el.videos.splice(idx, 1);
        saveElements();
        renderGalleryTab(el);
        renderSidebar();
        openMediaPicker(el);
      });
      grid.appendChild(item);
    });

    ALL_MEDIA.photos.forEach((src) => {
      const picked = el.photos.some((p) => (typeof p === "string" ? p : p.src) === src);
      const item = document.createElement("div");
      item.className = `media-pick-item${picked ? " picked" : ""}`;
      item.innerHTML = `
        <img src="${src}" loading="lazy" />
        <span class="media-pick-badge">✓</span>
        <span class="media-pick-name">${src}</span>
      `;
      item.addEventListener("click", () => {
        const idx = el.photos.findIndex((p) => (typeof p === "string" ? p : p.src) === src);
        if (idx >= 0) {
          el.photos.splice(idx, 1);
          item.classList.remove("picked");
        } else {
          el.photos.push(src);
          item.classList.add("picked");
        }
        saveElements();
        renderGalleryTab(el);
        renderSidebar();
      });
      grid.appendChild(item);
    });

    ALL_MEDIA.videos.forEach((src) => {
      const picked = el.videos.some((v) => (typeof v === "string" ? v : v.src) === src);
      const item = document.createElement("div");
      item.className = `media-pick-item${picked ? " picked" : ""}`;
      item.innerHTML = `
        <div style="font-size:28px;">🎥</div>
        <span class="media-pick-badge">✓</span>
        <span class="media-pick-name">${src.split("/").pop()}</span>
      `;
      item.addEventListener("click", () => {
        const idx = el.videos.findIndex((v) => (typeof v === "string" ? v : v.src) === src);
        if (idx >= 0) {
          el.videos.splice(idx, 1);
          item.classList.remove("picked");
        } else {
          el.videos.push(src);
          item.classList.add("picked");
        }
        saveElements();
        renderGalleryTab(el);
        renderSidebar();
      });
      grid.appendChild(item);
    });

    document.getElementById("media-modal").classList.add("open");
  }

  function renderSpecsTab(el) {
    el.specs = el.specs || {};
    const fields = [
      { key: "dimensioni", label: "📐 Dimensioni & Superficie" },
      { key: "altezzaPavimento", label: "📏 Altezza, Pavimento & Soffitto" },
      { key: "esposizione", label: "☀️ Esposizione Finestre & Luce" },
      { key: "caratteristiche", label: "✨ Caratteristiche Particolari" },
      { key: "noteProduzione", label: "🎬 Note Produzione" }
    ];

    if (!isEditingSpecs || isReadOnly) {
      let html = isReadOnly ? `<div class="spec-grid">` : `
        <div class="spec-actions">
          <button class="btn-danger" id="btn-delete-el">🗑️ Elimina</button>
          <button class="btn-primary" id="btn-edit-specs">✏️ Modifica</button>
        </div>
        <div class="spec-grid">
      `;
      fields.forEach((f) => {
        html += `
          <div class="spec-field">
            <div class="spec-field-label">${f.label}</div>
            <div class="spec-field-value">${escapeHtml(el.specs[f.key] || "—")}</div>
          </div>
        `;
      });
      html += `</div>`;
      drawerBodyEl.innerHTML = html;

      if (!isReadOnly) {
        document.getElementById("btn-edit-specs").addEventListener("click", () => {
          isEditingSpecs = true;
          renderSpecsTab(el);
        });
        document.getElementById("btn-delete-el").addEventListener("click", () => {
          if (!confirm(`Eliminare "${el.name}" dalla mappa?`)) return;
          elements = elements.filter((x) => x.id !== el.id);
          saveElements();
          closeDrawer();
          updateFilterCounts();
          updateHeaterSummary();
          renderMapLayers();
          renderSidebar();
        });
      }
    } else {
      let html = `
        <div class="spec-actions">
          <button class="btn-secondary" id="btn-cancel-specs">Annulla</button>
          <button class="btn-primary" id="btn-save-specs">💾 Salva</button>
        </div>
        <div class="spec-grid">
          <div class="spec-field">
            <div class="spec-field-label">🏷️ Nome Elemento</div>
            <input class="spec-input" id="edit-el-name" value="${escapeHtml(el.name)}" />
          </div>
          <div class="spec-field">
            <div class="spec-field-label">📂 Categoria & Livello</div>
            <div style="display:flex;gap:6px;">
              <select class="spec-input" id="edit-el-cat">
                ${Object.entries(CATEGORIES).map(([k, v]) => `<option value="${k}" ${el.category === k ? "selected" : ""}>${v.icon} ${v.label}</option>`).join("")}
              </select>
              <select class="spec-input" id="edit-el-floor" style="width:130px;">
                <option value="pt" ${el.floor === "pt" ? "selected" : ""}>Piano Terra</option>
                <option value="p1" ${el.floor === "p1" ? "selected" : ""}>Primo Piano</option>
              </select>
            </div>
          </div>
      `;
      fields.forEach((f) => {
        html += `
          <div class="spec-field">
            <div class="spec-field-label">${f.label}</div>
            <textarea class="spec-input" data-spec-key="${f.key}">${escapeHtml(el.specs[f.key] || "")}</textarea>
          </div>
        `;
      });
      html += `</div>`;
      drawerBodyEl.innerHTML = html;

      document.getElementById("btn-cancel-specs").addEventListener("click", () => {
        isEditingSpecs = false;
        renderSpecsTab(el);
      });
      document.getElementById("btn-save-specs").addEventListener("click", () => {
        el.name = document.getElementById("edit-el-name").value.trim() || el.name;
        el.category = document.getElementById("edit-el-cat").value;
        el.floor = document.getElementById("edit-el-floor").value;
        drawerBodyEl.querySelectorAll("[data-spec-key]").forEach((ta) => {
          el.specs[ta.dataset.specKey] = ta.value.trim();
        });
        saveElements();
        isEditingSpecs = false;
        updateFilterCounts();
        updateHeaterSummary();
        renderMapLayers();
        renderSidebar();
        selectLocation(el.id);
      });
    }
  }

  // ==================== LIGHTBOX ====================
  function openLightbox(photos, idx) {
    lbPhotos = photos;
    lbIndex = idx;
    updateLightbox();
    document.getElementById("lightbox").classList.add("open");
  }

  function closeLightbox() {
    document.getElementById("lightbox").classList.remove("open");
  }

  function stepLightbox(dir) {
    if (lbPhotos.length === 0) return;
    lbIndex = (lbIndex + dir + lbPhotos.length) % lbPhotos.length;
    updateLightbox();
  }

  function updateLightbox() {
    const src = lbPhotos[lbIndex];
    document.getElementById("lb-img").src = src;
    const label = src.startsWith("data:") ? "Foto caricata" : src;
    document.getElementById("lb-caption").textContent = `${lbIndex + 1} / ${lbPhotos.length} — ${label}`;
  }

  // ==================== EXPORT / IMPORT ====================
  function exportJSON() {
    const payload = { calib, elements };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "villa-belloli-progetto.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  function importJSON(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (parsed.elements && Array.isArray(parsed.elements)) {
          elements = parsed.elements;
          saveElements();
        }
        if (parsed.calib) {
          calib = parsed.calib;
          saveCalibToStorage();
        }
        updateFilterCounts();
        updateHeaterSummary();
        renderMap();
        renderSidebar();
        alert("Progetto importato con successo!");
      } catch (err) {
        alert("File JSON non valido.");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
})();
