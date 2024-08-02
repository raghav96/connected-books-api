import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.7.1';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY')!;
const supabase = createClient(supabaseUrl, supabaseKey);

async function getEmbeddingsForBook(bookId: string) {
  const { data, error } = await supabase
    .from('documents')
    .select('embedding')
    .eq('metadata->>book_id', bookId);

  if (error) {
    throw new Error(`Error fetching embeddings for book ID ${bookId}: ${error.message}`);
  }

  return data.map((doc: any) => doc.embedding);
}

async function getSimilarBooks(embedding: any, matchThreshold: number, matchCount: number, bookId: string) {
  const { data, error } = await supabase.rpc('get_similar_books', {
    query_embedding: embedding,
    match_threshold: matchThreshold,
    match_count: matchCount,
    book_id: bookId
  });

  if (error) {
    throw new Error(`Get similar books: ${error.message}`);
  }

  return data;
}

async function aggregateSimilarBooks(bookId: string, matchThreshold: number, matchCount: number) {
  const embeddings = await getEmbeddingsForBook(bookId);
  const similarityMap = new Map();

  for (const embedding of embeddings) {
    const similarDocs = await getSimilarBooks(embedding, matchThreshold, matchCount, bookId);
    for (const doc of similarDocs) {
      const relatedBookId = doc.metadata.book_id;
      if (relatedBookId !== bookId) {
        const similarity = 1 - doc.similarity;
        if (similarityMap.has(relatedBookId)) {
          similarityMap.set(relatedBookId, similarityMap.get(relatedBookId) + similarity);
        } else {
          similarityMap.set(relatedBookId, similarity);
        }
      }
    }
  }

  const similarityArray = Array.from(similarityMap.entries());
  similarityArray.sort((a, b) => b[1] - a[1]);

  const topKeys = similarityArray.slice(0, 20).map(([key]) => key);
  const outputArray = [];

  for (const bookId of topKeys) {
    const outputData = await getMetadataForBookId(bookId);
    if (outputData) {
      outputArray.push({ id: bookId, data: outputData });
    }
  }

  return outputArray;
}

async function getMetadataForBookId(bookId: string) {
  const { data, error } = await supabase
    .from('documents')
    .select('metadata')
    .eq('metadata->>book_id', bookId)
    .single();

  if (error) {
    throw new Error(`Error fetching metadata for book ID ${bookId}: ${error.message}`);
  }

  return data.metadata;
}

Deno.serve(async (req) => {
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
    });
  }

  const url = new URL(req.url);
  const bookId = url.searchParams.get('book_id');
  const matchThreshold = parseFloat(url.searchParams.get('match_threshold') || '0.75');
  const topN = parseInt(url.searchParams.get('top_n') || '3', 3);

  if (!bookId) {
    return new Response(JSON.stringify({ error: 'Missing book_id parameter' }), {
      status: 400,
    });
  }

  try {
    const selectedBook = await getMetadataForBookId(bookId);
    if (!selectedBook) {
      return new Response(JSON.stringify({ error: 'Book not found' }), {
        status: 404,
      });
    }
    const similarBooks = await aggregateSimilarBooks(bookId, matchThreshold, topN);

    // Transform data into nodes and links
    const nodes = [];
    const links = [];
    const bookIdToNode = new Map();

    const selectedBookNode = {
      id: selectedBook.title,
      metadata: {
        id: bookId,
        data: selectedBook
      },
      group: selectedBook.locc.split('; ')[0] // Assuming locc is a property in the metadata
    };
    nodes.push(selectedBookNode);
    bookIdToNode.set(bookId, selectedBookNode);

    for (const book of similarBooks) {
      const node = {
        id: book.data.title,
        metadata: {
          id: book.data.book_id,
          data: book.data
        },
        group: book.data.locc.split('; ')[0] // Assuming locc is a property in the metadata
      };
      nodes.push(node);
      bookIdToNode.set(book.book_id, node);

      links.push({
        source: selectedBook.title,
        target: book.data.title,
        value: 1
      });
    }

    // Create links between similar books based on their LoCC codes
    const groupToNodes = new Map();
    for (const node of nodes) {
      if (!groupToNodes.has(node.group)) {
        groupToNodes.set(node.group, []);
      }
      groupToNodes.get(node.group).push(node);
    }

    for (const [group, groupNodes] of groupToNodes) {
      for (let i = 0; i < groupNodes.length; i++) {
        for (let j = i + 1; j < groupNodes.length; j++) {
          links.push({
            source: groupNodes[i].id,
            target: groupNodes[j].id,
            value: 1
          });
        }
      }
    }

    const graphData = { nodes, links };

    return new Response(
      JSON.stringify(graphData),
      {
        status: 200,
      }
    );
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
    });
  }
});
