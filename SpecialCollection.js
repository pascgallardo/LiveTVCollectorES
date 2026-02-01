const { request } = require('undici'); // Use undici for faster HTTP requests
const m3u8Parser = require('m3u8-parser');
const fs = require('fs').promises;
const path = require('path');
const yaml = require('js-yaml');

// Load p-limit dynamically since it's an ES Module
let pLimit;
(async () => {
    pLimit = (await import('p-limit')).default;
})();

// List of common country names for detection
const countries = [
    'USA', 'India', 'UK', 'Canada', 'Australia', 'Germany', 'France', 'Italy', 'Spain', 'Brazil',
    'China', 'Japan', 'Korea', 'Mexico', 'Russia', 'South Africa', 'Argentina', 'Netherlands', 'Sweden', 'Norway'
];

// Load configuration from YAML file
async function loadConfig() {
    try {
        const configContent = await fs.readFile('config.yml', 'utf8');
        return yaml.load(configContent);
    } catch (error) {
        console.error('Error loading config.yml:', error.message);
        process.exit(1);
    }
}

// Function to fetch M3U content from a URL
async function fetchM3U(url, timeout) {
    try {
        const { body, statusCode } = await request(url, {
            method: 'GET',
            maxRedirections: 2,
            timeout
        });
        if (statusCode !== 200) {
            throw new Error(`Failed to fetch ${url}: Status ${statusCode}`);
        }
        return await body.text();
    } catch (error) {
        console.error(`Error fetching ${url}:`, error.message);
        return null;
    }
}

// Function to parse M3U content and extract channel links with groups
function parseM3U(content) {
    const channels = [];
    const lines = content.split('\n');
    let currentChannel = null;

    lines.forEach(line => {
        line = line.trim();
        if (line.startsWith('#EXTINF')) {
            const groupMatch = line.match(/group-title="([^"]+)"/);
            const nameMatch = line.match(/,(.+)/);
            currentChannel = {
                name: nameMatch ? nameMatch[1] : 'Unknown',
                url: null,
                group: groupMatch ? groupMatch[1] : 'Unknown'
            };
        } else if (line && !line.startsWith('#') && currentChannel) {
            currentChannel.url = line;
            channels.push(currentChannel);
            currentChannel = null;
        }
    });

    return channels.filter(ch => ch.url); // Only return channels with URLs
}

// Function to check if a batch of links is active
async function checkLinkBatch(urls, timeout, concurrency) {
    // Wait for pLimit to be loaded
    while (!pLimit) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    const limit = pLimit(concurrency);
    const results = await Promise.allSettled(urls.map(url =>
        limit(async () => {
            try {
                const { statusCode } = await request(url, {
                    method: 'HEAD',
                    maxRedirections: 2,
                    timeout
                });
                return { url, isActive: statusCode >= 200 && statusCode < 400 };
            } catch (error) {
                return { url, isActive: false };
            }
        })
    ));

    return results
        .filter(result => result.status === 'fulfilled')
        .map(result => result.value)
        .filter(result => result.isActive); // Only return active links
}

// Function to collect and process all M3U links
async function collectActiveLinks(urls, concurrency, fetchTimeout, linkCheckTimeout, batchSize) {
    // Wait for pLimit to be loaded
    while (!pLimit) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    const limit = pLimit(concurrency);
    const allChannels = new Map(); // Use Map to avoid duplicates (keyed by URL)

    // Fetch all M3U playlists concurrently
    const fetchPromises = urls.map(url =>
        limit(async () => {
            console.log(`Fetching M3U from ${url}...`);
            const m3uContent = await fetchM3U(url, fetchTimeout);
            if (!m3uContent) return [];

            console.log(`Parsing M3U from ${url}...`);
            const channels = parseM3U(m3uContent);
            console.log(`Found ${channels.length} channels in ${url}`);

            // Add channels to the Map to remove duplicates early
            channels.forEach(channel => {
                if (!allChannels.has(channel.url)) {
                    allChannels.set(channel.url, channel);
                }
            });
            return channels;
        })
    );

    // Wait for all fetches to complete
    const allChannelsArrays = await Promise.allSettled(fetchPromises);
    allChannelsArrays
        .filter(result => result.status === 'fulfilled')
        .map(result => result.value)
        .flat();

    const uniqueChannels = Array.from(allChannels.values());

    // Batch process link checks to ensure only active links are included
    const activeChannels = [];
    for (let i = 0; i < uniqueChannels.length; i += batchSize) {
        const batch = uniqueChannels.slice(i, i + batchSize);
        console.log(`Checking batch ${i / batchSize + 1} (${batch.length} links)...`);
        const batchResults = await checkLinkBatch(
            batch.map(ch => ch.url),
            linkCheckTimeout,
            concurrency
        );

        batchResults.forEach(result => {
            const channel = allChannels.get(result.url);
            if (channel) {
                activeChannels.push(channel);
            }
        });
    }

    console.log(`Found ${activeChannels.length} active channels.`);
    return activeChannels;
}

// Function to group channels by group-title and country (if applicable)
function groupChannels(channels) {
    const grouped = {};

    channels.forEach(channel => {
        let group = channel.group || 'Unknown';
        let country = 'Unknown';

        // Check if the group contains a country name
        const foundCountry = countries.find(c => group.toLowerCase().includes(c.toLowerCase()));
        if (foundCountry) {
            country = foundCountry;
            // Remove the country from the group name to avoid redundancy
            group = group.replace(new RegExp(foundCountry, 'i'), '').trim() || 'General';
        }

        // Use group as the primary key, and country as a subgroup
        const groupKey = group === 'Unknown' ? 'Unknown' : group;
        if (!grouped[groupKey]) {
            grouped[groupKey] = {};
        }
        if (!grouped[groupKey][country]) {
            grouped[groupKey][country] = [];
        }
        grouped[groupKey][country].push(channel);
    });

    return grouped;
}

// Function to split channels into chunks of specified size
function splitChannels(channels, channelsPerFile) {
    const chunks = [];
    for (let i = 0; i < channels.length; i += channelsPerFile) {
        chunks.push(channels.slice(i, i + channelsPerFile));
    }
    return chunks;
}

// Function to delete a directory recursively
async function deleteDirectory(dirPath) {
    try {
        await fs.rm(dirPath, { recursive: true, force: true });
        console.log(`Deleted existing directory: ${dirPath}`);
    } catch (error) {
        if (error.code !== 'ENOENT') { // Ignore if directory doesn't exist
            console.error(`Error deleting directory ${dirPath}:`, error.message);
        }
    }
}

// Function to save active links to multiple formats with grouping and splitting
async function saveResults(channels, outputDirPrefix, channelsPerFile, concurrency) {
    // Wait for pLimit to be loaded
    while (!pLimit) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    const limit = pLimit(concurrency);

    // Delete the existing SpecialLinks directory to start fresh
    await deleteDirectory(outputDirPrefix);

    // Group channels by group-title and country
    const groupedChannels = groupChannels(channels);

    // Process each group and country in parallel, but only if there are active channels
    const savePromises = [];

    for (const [group, countries] of Object.entries(groupedChannels)) {
        for (const [country, groupChannels] of Object.entries(countries)) {
            // Skip if there are no active channels in this group/country
            if (groupChannels.length === 0) {
                console.log(`Skipping empty group: ${group}/${country}`);
                continue;
            }

            savePromises.push(limit(async () => {
                // Create a safe directory name by replacing invalid characters
                const safeGroup = group.replace(/[^a-zA-Z0-9]/g, '_');
                const safeCountry = country.replace(/[^a-zA-Z0-9]/g, '_');
                const groupDir = path.join(outputDirPrefix, safeGroup, safeCountry);

                // Ensure the directory exists
                await fs.mkdir(groupDir, { recursive: true });

                // Split channels into chunks of channelsPerFile
                const channelChunks = splitChannels(groupChannels, channelsPerFile);

                // Process each chunk
                for (let i = 0; i < channelChunks.length; i++) {
                    const chunk = channelChunks[i];
                    // Skip if the chunk is empty (shouldn't happen, but just in case)
                    if (chunk.length === 0) {
                        console.log(`Skipping empty chunk for ${group}/${country}`);
                        continue;
                    }

                    const suffix = i === 0 ? '' : (i + 1); // SpecialLinks, SpecialLinks2, etc.
                    const baseName = `SpecialLinks${suffix}`;

                    // Prepare content for all formats
                    let m3uContent = '#EXTM3U\n';
                    chunk.forEach(channel => {
                        m3uContent += `#EXTINF:-1 group-title="${group}",${channel.name}\n${channel.url}\n`;
                    });

                    const jsonContent = JSON.stringify(chunk, null, 2);
                    const txtContent = chunk.map(channel => channel.url).join('\n');

                    // Write all files in parallel
                    await Promise.all([
                        fs.writeFile(path.join(groupDir, `${baseName}.m3u`), m3uContent),
                        fs.writeFile(path.join(groupDir, `${baseName}.json`), jsonContent),
                        fs.writeFile(path.join(groupDir, `${baseName}.txt`), txtContent)
                    ]);

                    console.log(`Saved ${chunk.length} active links to ${groupDir}/${baseName}.*`);
                }
            }));
        }
    }

    // Wait for all save operations to complete
    const results = await Promise.allSettled(savePromises);

    // Check if any groups were processed
    const successfulSaves = results.filter(result => result.status === 'fulfilled');
    if (successfulSaves.length === 0) {
        console.log('No active channels found to save. Removing empty SpecialLinks directory.');
        await deleteDirectory(outputDirPrefix);
    }
}

// Main function to run the script
async function main() {
    console.log('Starting M3U link collection...');

    // Load configuration
    const config = await loadConfig();
    const { urls, settings } = config;
    const { concurrency, fetchTimeout, linkCheckTimeout, batchSize, outputDirPrefix, channelsPerFile } = settings;

    // Collect active links
    const activeChannels = await collectActiveLinks(urls, concurrency, fetchTimeout, linkCheckTimeout, batchSize);

    // Save results with grouping and splitting
    if (activeChannels.length > 0) {
        await saveResults(activeChannels, outputDirPrefix, channelsPerFile, concurrency);
    } else {
        console.log('No active links found.');
    }

    console.log('M3U link collection completed.');
}

main().catch(error => {
    console.error('Script failed:', error.message);
    process.exit(1);
});
