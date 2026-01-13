#ifndef JAR_CHUNK_MESH_DATA_H
#define JAR_CHUNK_MESH_DATA_H

#include <godot_cpp/classes/mesh.hpp>
#include <godot_cpp/variant/array.hpp>
#include <godot_cpp/variant/vector3.hpp>
#include <vector>
#include <unordered_map>
#include "bounds.h"
#include <glm/glm.hpp>
#define GLM_ENABLE_EXPERIMENTAL
#include <glm/gtx/hash.hpp>

using namespace godot;

class ChunkMeshData
{
  public:
    static const int MaxCollisionLod = 2;

    Array mesh_array;
    PackedVector3Array collision_mesh;
    int lod;
    uint16_t boundaries;
    bool edge_chunk;
    Bounds bounds;
    std::unordered_map<glm::ivec3, int> edgeVertices;
    // ChunkDetailData chunk_detail_data;

    bool has_collision_mesh() const
    {
        return true; // lod <= MaxCollisionLod;
    }

    ChunkMeshData(const Array &mesh_array, int lod, bool edge_chunk, const Bounds &chunk_bounds)
        : mesh_array(mesh_array), lod(lod), edge_chunk(edge_chunk), bounds(chunk_bounds)
    {
        if (has_collision_mesh())
        {
            // collision_mesh = get_collision_mesh();
        }
    }

    // void instantiate_details() {
    //     chunk_detail_data = ChunkDetailData(this);
    // }

    PackedVector3Array create_collision_mesh() const {
        PackedVector3Array verts = mesh_array[Mesh::ARRAY_VERTEX];
        PackedInt32Array indices = mesh_array[Mesh::ARRAY_INDEX];
        PackedVector3Array collision_mesh;

        for (size_t i = 0; i < indices.size(); i++) {
            collision_mesh.push_back(verts[indices[i]]);
        }

        return collision_mesh;
    }

    // bool should_have_grass_texture() const {
    //     return chunk_detail_data.should_have_grass_texture();
    // }
};

#endif // JAR_CHUNK_MESH_DATA_H
