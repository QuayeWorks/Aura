#include "chunk_detail_generator.h"
#include "chunk_mesh_data.h"
#include "voxel_terrain.h"
#include "world.h"

ChunkDetailGenerator::ChunkDetailGenerator(JarWorld *world) : world(world)
{
    // Constructor implementation
    // load details
}

ChunkDetailGenerator::~ChunkDetailGenerator()
{
    // Destructor implementation
}

Vector3 ChunkDetailGenerator::get_gravity_normal(const Vector3 &position) const
{
    if (world != nullptr)
        return world->get_gravity_vector(position).normalized();

    return Vector3(0, -1, 0);
}

float ChunkDetailGenerator::get_height(const Vector3 &position) const
{
    if (world != nullptr)
        return world->get_height(position);

    return position.y;
}

TypedArray<MultiMesh> ChunkDetailGenerator::generate_details(const TypedArray<JarTerrainDetail> &details,
                                                             const ChunkMeshData &chunkMeshData)
{
    _verts = chunkMeshData.mesh_array[static_cast<int>(Mesh::ArrayType::ARRAY_VERTEX)];
    _indices = chunkMeshData.mesh_array[static_cast<int>(Mesh::ArrayType::ARRAY_INDEX)];
    _normals = chunkMeshData.mesh_array[static_cast<int>(Mesh::ArrayType::ARRAY_NORMAL)];
    _colors = chunkMeshData.mesh_array[static_cast<int>(Mesh::ArrayType::ARRAY_COLOR)];

    glm::vec3 chunkCenterGLM = chunkMeshData.bounds.get_center();
    Vector3 chunkCenter = Vector3(chunkCenterGLM.x, chunkCenterGLM.y, chunkCenterGLM.z);
    if (details.size() <= 0)
        return TypedArray<MultiMesh>();

    std::vector<std::vector<Transform3D>> ts(details.size());
    for (size_t i = 0; i < _indices.size(); i += 3)
    {
        Vector3 posA = _verts[_indices[i]];
        Vector3 posB = _verts[_indices[i + 1]];
        Vector3 posC = _verts[_indices[i + 2]];

        Vector3 edge1 = posB - posA;
        Vector3 edge2 = posC - posA;
        float area = edge1.cross(edge2).length() * 0.5f;

        for (size_t d = 0; d < details.size(); d++)
        {
            Ref<JarTerrainDetail> detail = details[d];
            float n = area * detail->get_density();
            int nInt = static_cast<int>(std::floor(n));
            float nFloat = DeterministicFloat((posA + posB + posC) * (1 + d));
            nInt += (nFloat < (n - nInt)) ? 1 : 0;
            // nInt = 1;

            for (int j = 0; j < nInt; j++)
            {
                float r1 = DeterministicFloat(posA * (1 + d));
                float r2 = DeterministicFloat(posB * (1 + d));
                if (r1 + r2 >= 1)
                {
                    r1 = 1 - r1;
                    r2 = 1 - r2;
                }

                Vector3 position = posA + r1 * edge1 + r2 * edge2;
                Vector3 worldPosition = position + chunkCenter;
                Vector3 world_up = -get_gravity_normal(worldPosition);
                float height = get_height(worldPosition);


                if (!detail->is_height_in_range(height))
                    continue;

                Vector3 up = _normals[_indices[i]] + r1 * (_normals[_indices[i + 1]] - _normals[_indices[i]]) +
                             r2 * (_normals[_indices[i + 2]] - _normals[_indices[i]]);
                Color color = _colors[_indices[i]] + r1 * (_colors[_indices[i + 1]] - _colors[_indices[i]]) +
                              r2 * (_colors[_indices[i + 2]] - _colors[_indices[i]]);
                up = up.normalized();

                float dot = up.dot(world_up);

                if (detail->is_slope_in_range(dot) || color.r > 0.5)
                    continue;

                if (!detail->get_align_with_normal())
                    up = world_up;

                float r3 = DeterministicFloat(posC * (1 + d));
                float r4 = DeterministicFloat((posA + posC) * (1 + d));

                ts[d].emplace_back(
                    detail->build_transform(position, up, r3 * 2 * Math_PI,
                                            Math::lerp(detail->get_minimum_scale(), detail->get_maximum_scale(), r4)));
            }
        }
    }

    TypedArray<MultiMesh> meshes;
    for (size_t d = 0; d < details.size(); d++)
    {
        Ref<JarTerrainDetail> detail = details[d];
        // for (const auto &lod : detail->Visuals) {
        Ref<MultiMesh> mesh = memnew(MultiMesh());
        mesh->set_transform_format(MultiMesh::TRANSFORM_3D);
        mesh->set_mesh(detail->get_mesh());
        mesh->set_instance_count(ts[d].size());

        for (size_t i = 0; i < ts[d].size(); i++)
        {
            mesh->set_instance_transform(i, ts[d][i]);
        }

        meshes.append(mesh);
        // }
    }

    return meshes;
}