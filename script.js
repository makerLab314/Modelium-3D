document.addEventListener('DOMContentLoaded', () => {
    // --- KONFIGURATION ---
    // Trage hier die URL deiner Vercel-API ein
    const API_URL = 'https://modelium-proxy.vercel.app/api/search'; // WICHTIG: ANPASSEN!

    // --- ELEMENTE ---
    const searchInput = document.getElementById('searchInput');
    const searchButton = document.getElementById('searchButton');
    const resultsGrid = document.getElementById('resultsGrid');
    const spinner = document.getElementById('spinner');
    const statusContainer = document.getElementById('statusContainer');

    // --- EVENT LISTENERS ---
    searchButton.addEventListener('click', handleSearch);
    searchInput.addEventListener('keyup', (event) => {
        if (event.key === 'Enter') {
            handleSearch();
        }
    });

    // --- FUNKTIONEN ---
    async function handleSearch() {
        const query = searchInput.value.trim();
        if (!query) {
            showStatus('Bitte gib einen Suchbegriff ein.');
            return;
        }

        // UI für Ladezustand vorbereiten
        setLoadingState(true);
        resultsGrid.innerHTML = '';
        statusContainer.innerHTML = '';

        try {
            const response = await fetch(`${API_URL}?q=${encodeURIComponent(query)}`);
            if (!response.ok) {
                throw new Error(`API-Fehler: ${response.statusText}`);
            }
            const results = await response.json();
            displayResults(results);

        } catch (error) {
            console.error('Fehler bei der Suche:', error);
            showStatus('Hoppla, da ist etwas schiefgelaufen. Versuch es später nochmal.');
        } finally {
            // Ladezustand beenden
            setLoadingState(false);
        }
    }

// Ersetze deine bestehende displayResults Funktion mit dieser:

function displayResults(results) {
    if (results.length === 0) {
        showStatus('Keine Modelle für deine Suche gefunden.');
        return;
    }

    showStatus(`${results.length} Modelle gefunden.`);

    results.forEach(item => {
        const card = document.createElement('a');
        card.className = 'result-card';
        card.href = item.url;
        card.target = '_blank';
        card.rel = 'noopener noreferrer';

        // Die Author-Prüfung ist hier wichtig, da nicht jede API immer einen Autor liefert
        const authorName = item.author ? escapeHtml(item.author) : 'Unbekannt';
        const titleName = item.title ? escapeHtml(item.title) : 'Ohne Titel';

        card.innerHTML = `
            <img src="${item.imageUrl}" alt="${titleName}" loading="lazy">
            <div class="card-content">
                <h3 class="card-title">${titleName}</h3>
                <div class="card-footer">
                    <span class="card-author">${authorName}</span>
                    <span class="card-source ${item.source}">${item.source}</span>
                </div>
            </div>
        `;
        resultsGrid.appendChild(card);
    }); // <-- Achte darauf, dass diese Zeile mit `);` endet
} // <-- Und diese Zeile die Funktion mit `}` abschließt
