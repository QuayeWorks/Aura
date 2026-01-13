#include <vector>
#include <godot_cpp/classes/multi_mesh.hpp>
// #include <godot_cpp/classes/array.hpp>
// #include <godot_cpp/classes/transform3d.hpp>
#include <godot_cpp/classes/mesh.hpp>
#include <godot_cpp/variant/vector3.hpp>
#include <godot_cpp/variant/color.hpp>
#include <godot_cpp/templates/hashfuncs.hpp>
// #include <godot_cpp/variant/math.hpp>
#include <godot_cpp/variant/utility_functions.hpp>

#include "terrain_detail.h"

using namespace godot;

class JarVoxelTerrain;
class ChunkMeshData;
class JarWorld;

class ChunkDetailGenerator {
private:
    PackedVector3Array _verts;
    PackedInt32Array _indices;
    PackedVector3Array _normals;
    PackedColorArray _colors;
    JarWorld *world;

    float DeterministicFloat(const Vector3 &input) const {
        // Generate a deterministic float based on the input vector
        uint32_t hash = HashMapHasherDefault::hash(input);
        return static_cast<float>(hash % 10000) / 10000.0f; // Normalize to [0, 1]
    }

public:
    ChunkDetailGenerator(JarWorld *world);
    ~ChunkDetailGenerator();

    Vector3 get_gravity_normal(const Vector3 &position) const;

    float get_height(const Vector3 &position) const;

    TypedArray<MultiMesh> generate_details(const TypedArray<JarTerrainDetail> &details, const ChunkMeshData &chunkMeshData);
};